import { Authentication } from "@opencode-ai/core/authentication"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { type ChildProcess as ChildProcessType } from "child_process"
import { spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { detectProject, type ProjectInfo } from "./detect"
import { registerDisposer } from "@/effect/instance-registry"

const STARTUP_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 120_000
// A running dev server is reclaimed only after this long with no heartbeat, no
// proxied request, and no HMR traffic. Comfortably longer than the app
// heartbeat so background throttling (browsers clamp timers to ~60s) can never
// evict a server the user is still viewing.
const IDLE_TTL_MS = readPositiveEnv("OPENCODE_PREVIEW_IDLE_TTL_MS", 180_000)
// A soft release (the app says "I'm done") backdates `lastActive` so eviction
// happens after this shorter grace. Any heartbeat or request cancels it, so a
// transient pagehide/unmount can never kill a preview another tab still uses.
const RELEASE_GRACE_MS = readPositiveEnv("OPENCODE_PREVIEW_RELEASE_GRACE_MS", 90_000)
// Graceful teardown: ask the dev server's process group to stop, then force it.
const TERM_GRACE_MS = 4_000
const KILL_GRACE_MS = 3_000

function readPositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface DevServer {
  process: ChildProcessType
  port: number
  hostname: string
  projectInfo: ProjectInfo
  status: "starting" | "running" | "error" | "installing"
  directory: string
  refs: number
  lastActive: number
}

const servers = new Map<string, DevServer>()
const slugToDir = new Map<string, string>()
const locks = new Map<string, Promise<{ sessionId: string; port: number; framework: string }>>()
const portMap = new Map<string, number>()
// Clients that shared an in-flight start promise without bumping the running
// server's refs. Merged into server.refs when the start settles so a stop from
// one owner can't SIGKILL a server another owner still depends on.
const pendingRefs = new Map<string, number>()
// Progress for a directory that has no `servers` entry yet (install/start are
// observable before the process is running). Cleared once the server stops.
const progress = new Map<string, { phase: PreviewPhase; message?: string }>()
// Idle reclamation is deadline-driven, not polled: one timer fires exactly when
// the earliest tracked server becomes idle. `sweepOwner` is that server, which
// lets a touch skip rescheduling unless it moved the earliest deadline.
let sweepTimer: ReturnType<typeof setTimeout> | undefined
let sweepTarget = Infinity
let sweepOwner: string | undefined

export type PreviewPhase = "installing" | "starting" | "running" | "error"

function setProgress(directory: string, phase: PreviewPhase, message?: string): void {
  progress.set(directory, { phase, message })
}

function clearProgress(directory: string): void {
  progress.delete(directory)
}

function appendHostFlag(command: string, _packageManager: string, port: number, projectInfo: ProjectInfo): string {
  const isDocker = existsSync("/.dockerenv") || process.env.OPENCODE_DOCKER === "1"
  const parts: string[] = []
  if (projectInfo.supportsHost) {
    parts.push(Authentication.central() ? "--host 127.0.0.1" : isDocker ? "--host 0.0.0.0" : "--host localhost")
  }
  if (projectInfo.portFlag) {
    parts.push(`${projectInfo.portFlag} ${port}`)
  }
  if (parts.length === 0) return command
  const flags = parts.join(" ")
  if (command.includes("npm run") || command.includes("bun run")) return `${command} -- ${flags}`
  return `${command} ${flags}`
}

function dirSlug(directory: string): string {
  return directory.split("/").filter(Boolean).pop() || "unknown"
}

async function isPortAvailable(port: number): Promise<boolean> {
  const net = await import("net")
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, () => {
      server.close(() => resolve(true))
    })
  })
}

async function getOrCreatePort(directory: string): Promise<number> {
  const stored = portMap.get(directory)
  if (stored && (await isPortAvailable(stored))) return stored
  const port = await findFreePort()
  portMap.set(directory, port)
  return port
}

async function findFreePort(): Promise<number> {
  const net = await import("net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        server.close(() => resolve(addr.port))
      } else {
        server.close(() => reject(new Error("Failed to find free port")))
      }
    })
    server.on("error", reject)
  })
}

function previewEnvironment() {
  if (!Authentication.central()) return process.env
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^OPENCODE_(DATABASE_|JWT_|REGISTRATION_|SIGNUP_|DATA_KEY|SERVER_PASSWORD)/.test(key),
    ),
  )
}

function hasNodeModules(directory: string): boolean {
  return existsSync(path.join(directory, "node_modules"))
}

function getInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case "bun":
      return "bun install --ignore-scripts"
    case "pnpm":
      return "pnpm install --ignore-scripts"
    case "yarn":
      return "yarn install --ignore-scripts"
    default:
      return "npm install --ignore-scripts"
  }
}

async function installDependencies(directory: string, packageManager: string): Promise<void> {
  if (hasNodeModules(directory)) return
  const cmd = getInstallCommand(packageManager)
  await CentralStorage.check()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Install timed out")), INSTALL_TIMEOUT_MS)
    const child = spawn("sh", ["-c", cmd], {
      cwd: directory,
      env: previewEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout?.on("data", (d: Buffer) => {
      output = (output + d.toString()).slice(-64 * 1024)
    })
    child.stderr?.on("data", (d: Buffer) => {
      output = (output + d.toString()).slice(-64 * 1024)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Install failed (code ${code}): ${output.slice(-300)}`))
    })
    child.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s]+(\d{2,5})/g
const LOCAL_RE =
  /(?:Local|App|ready|started|starting|listening|running|serving|Server running|http server|VITE|Accepting connections at|Development Server|Uvicorn running|Serving HTTP|Webpack|Server address)[\s:()]*(https?:\/\/[^\s)]+)/i
const BOUND_RE =
  /(?:bound|listening on|listening at|available at|running on|serving on|server started on|Accepting connections at)[\s:]*(?:https?:\/\/)?([^\s:]+):(\d+)/i
// The lookahead crosses newlines: "Port X is in use, trying another one..." may
// be split across lines, and a handled retry must not count as a failure.
const FAIL_RE = /already running|EADDRINUSE|address already in use|port \d+ (?:is )?in use(?![\s\S]*trying another)/i

function extractHostAndPort(output: string): { host: string; port: number } | null {
  // PORT_RE is module-global; a previous early return leaves lastIndex mid-scan.
  PORT_RE.lastIndex = 0
  const m = LOCAL_RE.exec(output)
  if (m) {
    try {
      const url = new URL(m[1])
      const port = url.port ? Number(url.port) : null
      if (port) return { host: url.hostname, port }
    } catch {}
  }
  const m2 = BOUND_RE.exec(output)
  if (m2 && m2[2]) return { host: m2[1], port: Number(m2[2]) }
  let match: RegExpExecArray | null
  while ((match = PORT_RE.exec(output)) !== null) {
    const port = Number(match[1])
    if (port >= 1000 && port <= 65535) return { host: match[0].split(/[:\s]/)[0], port }
  }
  return null
}

function isReadyOutput(output: string): boolean {
  return /ready|listening|started|starting|running|serving|compiled|vite.*ready|server running|available at|accepting connections|development server|uvicorn|webpack|rails/i.test(
    output,
  )
}

// A child we spawned and that is still running. The exitCode/signalCode/killed
// checks are what stop us from ever signalling a dead PID that the OS may have
// since reused for an unrelated process (e.g. the project's own dev server).
function isOwnedLiveChild(child: ChildProcessType): boolean {
  return Boolean(child.pid) && child.exitCode === null && child.signalCode === null && !child.killed
}

// Signal the child's process group (it is spawned detached, so the group id is
// the child pid and killing it reaches sub-processes), plus the child itself.
// Never touch our own process, our parent, or PID 1.
function signalTree(child: ChildProcessType, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid || pid <= 1 || pid === process.pid || pid === process.ppid) return
  try {
    process.kill(-pid, signal)
  } catch {}
  try {
    child.kill(signal)
  } catch {}
}

// Immediate SIGKILL, used only to abort a start we are already rejecting.
function forceKillTree(child: ChildProcessType): void {
  if (!isOwnedLiveChild(child)) return
  signalTree(child, "SIGKILL")
}

function waitForExit(child: ChildProcessType, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isOwnedLiveChild(child)) {
      resolve(true)
      return
    }
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener("exit", onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once("exit", onExit)
  })
}

// Graceful teardown: SIGTERM the group, give it a moment to flush, then SIGKILL.
async function killTreeGracefully(child: ChildProcessType): Promise<void> {
  if (!isOwnedLiveChild(child)) return
  signalTree(child, "SIGTERM")
  if (await waitForExit(child, TERM_GRACE_MS)) return
  if (!isOwnedLiveChild(child)) return
  signalTree(child, "SIGKILL")
  await waitForExit(child, KILL_GRACE_MS)
}

/** Dispose only processes owned by this runtime; never sweep unrelated listening ports. */
export async function initPreview(): Promise<void> {
  for (const server of servers.values()) terminateServer(server)
}

/**
 * Dev-server start failure. `staticFallback` tells the caller whether showing
 * the project's raw index.html is meaningful (static sites) or would just
 * render a blank SPA shell (framework projects with a failed dev server).
 */
export class PreviewStartError extends Error {
  constructor(
    message: string,
    readonly framework: string,
    readonly staticFallback: boolean,
  ) {
    super(message)
    this.name = "PreviewStartError"
  }
}

export async function startDevServer(
  directory: string,
): Promise<{ sessionId: string; port: number; framework: string }> {
  directory = await CentralStorage.resolveWorkspace(directory)
  const existing = servers.get(directory)
  if (existing && existing.status === "running" && existing.port > 0) {
    existing.refs++
    existing.lastActive = Date.now()
    rescheduleSweep()
    return { sessionId: directory, port: existing.port, framework: existing.projectInfo.framework }
  }
  const pending = locks.get(directory)
  if (pending) {
    pendingRefs.set(directory, (pendingRefs.get(directory) ?? 0) + 1)
    return pending.finally(() => {
      const extra = pendingRefs.get(directory) ?? 0
      if (extra > 0) {
        pendingRefs.delete(directory)
        const server = servers.get(directory)
        if (server) server.refs += extra
      }
    })
  }
  const promise = startDevServerInner(directory)
  locks.set(directory, promise)
  void promise
    .catch((err) => {
      console.warn(`[preview] Dev server failed for ${directory}: ${err instanceof Error ? err.message : err}`)
    })
    .finally(() => {
      if (locks.get(directory) === promise) locks.delete(directory)
    })
  return promise
}

async function startDevServerInner(directory: string): Promise<{ sessionId: string; port: number; framework: string }> {
  const existing = servers.get(directory)
  if (existing && existing.status === "running" && existing.port > 0) {
    existing.refs++
    existing.lastActive = Date.now()
    rescheduleSweep()
    return { sessionId: directory, port: existing.port, framework: existing.projectInfo.framework }
  }
  if (existing) {
    servers.delete(directory)
    await killTreeGracefully(existing.process)
  }

  const projectInfo = await detectProject(directory)
  if (!projectInfo)
    throw new PreviewStartError("No dev server command found. Add a 'dev' script to package.json.", "unknown", false)

  if (projectInfo.framework !== "static") {
    const installing = !hasNodeModules(directory)
    setProgress(directory, "installing", installing ? "Installing dependencies…" : undefined)
    try {
      await installDependencies(directory, projectInfo.packageManager)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Dependency install failed."
      setProgress(directory, "error", message)
      throw new PreviewStartError(message, projectInfo.framework, false)
    }
  }

  setProgress(directory, "starting", "Starting dev server…")

  const isDocker = existsSync("/.dockerenv") || process.env.OPENCODE_DOCKER === "1"
  const port = await getOrCreatePort(directory)
  const bind = Authentication.central() ? "127.0.0.1" : isDocker ? "0.0.0.0" : "localhost"
  const env = {
    ...previewEnvironment(),
    PORT: String(port),
    HOST: bind,
    HOSTNAME: bind,
    VITE_HOST: bind,
    BIND: bind,
    BROWSER: "none",
  }
  const command = appendHostFlag(projectInfo.command, projectInfo.packageManager, port, projectInfo)
  await CentralStorage.check()
  const child = spawn("sh", ["-c", command], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: true })

  const server: DevServer = {
    process: child,
    port: 0,
    hostname: process.env.OPENCODE_HOST || "localhost",
    projectInfo,
    status: "starting",
    directory,
    refs: 1,
    lastActive: Date.now(),
  }
  servers.set(directory, server)
  rescheduleSweep()

  return new Promise((resolve, reject) => {
    let output = ""
    let resolved = false
    let detected: { host: string; port: number } | null = null
    const startError = (message: string) =>
      new PreviewStartError(message, projectInfo.framework, projectInfo.framework === "static")

    const cleanup = (err?: Error) => {
      if (resolved) return
      resolved = true
      forceKillTree(child)
      if (!detected) servers.delete(directory)
      if (err) {
        setProgress(directory, "error", err.message)
        reject(err)
      }
    }

    const timeout = setTimeout(() => {
      cleanup(startError(`Dev server timed out after ${STARTUP_TIMEOUT_MS / 1000}s. Output:\n${output.slice(-500)}`))
    }, STARTUP_TIMEOUT_MS)

    const handleOutput = (data: Buffer) => {
      const chunk = data.toString()
      output = (output + chunk).slice(-64 * 1024)
      if (!resolved && FAIL_RE.test(output)) {
        clearTimeout(timeout)
        cleanup(startError(`Dev server failed to start. Output:\n${output.slice(-500)}`))
        return
      }
      if (!resolved && !detected) detected = extractHostAndPort(output)
      if (!resolved && detected && isReadyOutput(output)) {
        clearTimeout(timeout)
        resolved = true
        server.port = detected.port
        server.hostname = detected.host
        server.status = "running"
        portMap.set(directory, detected.port)
        slugToDir.set(dirSlug(directory), directory)
        setProgress(directory, "running")
        rescheduleSweep()
        resolve({ sessionId: directory, port: detected.port, framework: projectInfo.framework })
      }
    }

    child.stdout?.on("data", handleOutput)
    child.stderr?.on("data", handleOutput)
    child.on("error", (err) => cleanup(startError(err.message)))
    child.on("exit", (code, signal) => {
      clearTimeout(timeout)
      const message = `Dev server exited with code ${signal || code}. Output:\n${output.slice(-500)}`
      if (!resolved) {
        resolved = true
        server.status = "error"
        servers.delete(directory)
        setProgress(directory, "error", message)
        reject(startError(message))
      } else if (servers.get(directory) === server) {
        servers.delete(directory)
        setProgress(directory, "error", message)
      }
    })
  })
}

// Hard, refcounted stop: terminates once the last referenced owner releases.
export function stopDevServer(directory: string): boolean {
  const server = servers.get(directory)
  if (server) {
    server.refs = Math.max(0, server.refs - 1)
    if (server.refs > 0) return false
    if ((pendingRefs.get(directory) ?? 0) > 0) return false
    terminateServer(server)
    return true
  }
  const pending = pendingRefs.get(directory)
  if (pending && pending > 0) pendingRefs.set(directory, pending - 1)
  return false
}

// Soft release used by the app when it stops displaying a preview. The server
// keeps running but is backdated so idle eviction happens after RELEASE_GRACE_MS,
// and any heartbeat, proxied request, or re-start cancels it. This is what makes
// a transient unmount or bfcache pagehide safe: a stray release can never stop a
// preview another tab (or a quick re-open) is still using.
export function releaseDevServer(directory: string): boolean {
  const server = servers.get(directory)
  if (!server) {
    const pending = pendingRefs.get(directory)
    if (pending && pending > 0) pendingRefs.set(directory, pending - 1)
    return false
  }
  server.refs = Math.max(0, server.refs - 1)
  if (server.refs > 0) return false
  if ((pendingRefs.get(directory) ?? 0) > 0) return false
  server.lastActive = Date.now() - (IDLE_TTL_MS - RELEASE_GRACE_MS)
  rescheduleSweep()
  return true
}

// Unconditional teardown for instance disposal: the workspace is going away, so
// every process this runtime owns for it must stop regardless of refcount.
export function destroyDevServer(directory: string): boolean {
  const server = servers.get(directory)
  if (!server) return false
  terminateServer(server)
  return true
}

export function touchDevServer(directory: string): void {
  const server = servers.get(directory)
  if (!server) return
  server.lastActive = Date.now()
  // Only the earliest eviction deadline shapes the timer. Touching any other
  // server leaves that deadline unchanged, so skip the reschedule.
  if (sweepOwner === directory) rescheduleSweep()
}

export function collectIdleServers(
  entries: Iterable<{ directory: string; lastActive: number }>,
  now: number,
  idleMs: number,
): string[] {
  const idle: string[] = []
  for (const entry of entries) {
    if (now - entry.lastActive > idleMs) idle.push(entry.directory)
  }
  return idle
}

function terminateServer(server: DevServer): void {
  servers.delete(server.directory)
  slugToDir.delete(dirSlug(server.directory))
  portMap.delete(server.directory)
  clearProgress(server.directory)
  void killTreeGracefully(server.process)
  rescheduleSweep()
}

function sweepIdleServers(): void {
  sweepTimer = undefined
  sweepTarget = Infinity
  sweepOwner = undefined
  const now = Date.now()
  for (const directory of collectIdleServers(servers.values(), now, IDLE_TTL_MS)) {
    const server = servers.get(directory)
    // Only reclaim a server that actually reached "running"; a starting server
    // is bounded by its own startup timeout and a failed entry was removed.
    if (server && server.status === "running") terminateServer(server)
  }
  rescheduleSweep()
}

// Deadline-driven reclamation: one timer wakes exactly when the earliest tracked
// server becomes idle. No periodic polling, and no wakeups while nothing is
// running. The timer is unref'd so it never keeps the process alive.
function rescheduleSweep(): void {
  if (sweepTimer !== undefined) {
    clearTimeout(sweepTimer)
    sweepTimer = undefined
  }
  sweepTarget = Infinity
  sweepOwner = undefined
  for (const server of servers.values()) {
    const deadline = server.lastActive + IDLE_TTL_MS
    if (deadline < sweepTarget) {
      sweepTarget = deadline
      sweepOwner = server.directory
    }
  }
  if (sweepOwner === undefined) return
  sweepTimer = setTimeout(sweepIdleServers, Math.max(0, sweepTarget - Date.now()))
  sweepTimer.unref?.()
}

registerDisposer(async (directory) => {
  destroyDevServer(directory)
})

export function directoryFromSlug(slug: string): string | undefined {
  return slugToDir.get(slug)
}

export function getDevServerStatus(directory: string): {
  running: boolean
  hostname?: string
  port?: number
  framework?: string
  phase?: PreviewPhase
  message?: string
} {
  const server = servers.get(directory)
  if (!server || server.status !== "running") {
    if (server && !isOwnedLiveChild(server.process)) {
      terminateServer(server)
      return { running: false }
    }
    const current = progress.get(directory)
    return { running: false, phase: current?.phase, message: current?.message }
  }
  if (!isOwnedLiveChild(server.process)) {
    terminateServer(server)
    return { running: false }
  }
  return {
    running: true,
    hostname: server.hostname,
    port: server.port,
    framework: server.projectInfo.framework,
    phase: "running",
  }
}

/** Proxy only ports registered to a running workspace process, never arbitrary localhost services. */
export function previewDirectoryForPort(port: number) {
  for (const server of servers.values()) {
    if (server.status === "running" && server.port === port && isOwnedLiveChild(server.process)) return server.directory
  }
  return undefined
}
