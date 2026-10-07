import { spawn } from "child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { getDevServerStatus } from "./server"

/** Fixed capture surface so thumbnails look the same on every screen size. */
export const CAPTURE_WIDTH = 1200
export const CAPTURE_HEIGHT = 600

const CAPTURE_TIMEOUT_MS = 45_000
const CAPTURE_ATTEMPTS = 2
const READY_BUDGET_MS = 8_000
const VIRTUAL_TIME_BUDGET_MS = 6_000
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const STDERR_LIMIT = 8 << 10
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CHROME_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
const CHROME_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]

/** Thrown when there is no rendered preview to capture, so callers keep the existing thumbnail. */
export class PreviewUnavailableError extends Error {
  readonly _tag = "PreviewCapture.PreviewUnavailableError"
}

export function resolveChromium(): string {
  const configured = process.env.OPENCODE_CHROME_BIN ?? process.env.CHROME_PATH
  if (configured && existsSync(configured)) return configured
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    for (const name of CHROME_NAMES) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return configured ?? "chromium"
}

export function chromiumArgs(url: string, screenshot: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
    "--default-background-color=0f172aff",
    "--run-all-compositor-stages-before-draw",
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    `--screenshot=${screenshot}`,
    url,
  ]
}

export async function captureUrl(url: string): Promise<Buffer> {
  const workdir = await mkdtemp(path.join(tmpdir(), "omai-capture-"))
  const screenshot = path.join(workdir, "preview.png")
  try {
    let failure: unknown
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      try {
        return await captureAttempt(url, screenshot)
      } catch (error) {
        failure = error
      }
    }
    throw failure
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

async function captureAttempt(url: string, screenshot: string): Promise<Buffer> {
  const result = await run(resolveChromium(), chromiumArgs(url, screenshot))
  const data = await readFile(screenshot).catch(() => undefined)
  // Chromium sometimes exits non-zero while tearing down after the screenshot
  // was written, so the artifact decides success, not the exit code.
  if (data?.subarray(0, 8).equals(pngSignature)) {
    if (data.byteLength > MAX_CAPTURE_BYTES) throw new Error("The preview screenshot was too large to store.")
    return data
  }
  throw new Error(
    result.code === 0
      ? "Chromium did not produce a valid screenshot."
      : result.stderr.trim().split("\n").at(-1)?.trim() || `Chromium exited with code ${result.code}.`,
  )
}

const captures = new Map<string, Promise<Buffer>>()

/** One capture per project at a time; concurrent requests share the in-flight screenshot. */
export function capturePreview(directory: string): Promise<Buffer> {
  const pending = captures.get(directory)
  if (pending) return pending
  const task = captureFor(directory).finally(() => captures.delete(directory))
  captures.set(directory, task)
  return task
}

async function captureFor(directory: string): Promise<Buffer> {
  const status = getDevServerStatus(directory)
  if (status.running && status.port) {
    const url = `http://127.0.0.1:${status.port}/`
    await waitForPreview(url)
    return captureUrl(url)
  }
  const snapshot = await latestSnapshot(directory)
  if (snapshot) return captureUrl(pathToFileURL(snapshot).href)
  throw new PreviewUnavailableError("No preview is running for this project.")
}

/** Screenshots are only stored once the preview answers, so a booting dev server never becomes a blank thumbnail. */
async function waitForPreview(url: string): Promise<void> {
  const deadline = Date.now() + READY_BUDGET_MS
  let delay = 200
  for (;;) {
    const ready = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    if (Date.now() >= deadline)
      throw new PreviewUnavailableError("The preview did not respond in time to be captured.")
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 2_000)
  }
}

async function latestSnapshot(directory: string): Promise<string | null> {
  const root = await CentralStorage.resolveWorkspace(path.join(directory, ".OMAI+", "preview")).catch(() => null)
  if (!root) return null
  const entries = await readdir(root).catch(() => [] as string[])
  let newest: { file: string; mtime: number } | null = null
  for (const name of entries) {
    if (!/^[a-f0-9-]{36}\.html$/.test(name)) continue
    const file = path.join(root, name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    if (!newest || info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs }
  }
  return newest?.file ?? null
}

function run(bin: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] })
    let settled = false
    let stderr = ""

    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle()
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(() => reject(new Error("The screenshot timed out.")))
    }, CAPTURE_TIMEOUT_MS)

    child.on("error", (error) =>
      finish(() =>
        reject(
          error instanceof Error
            ? new Error(`Chromium could not be started at ${bin}: ${error.message}`)
            : new Error("Chromium could not be started."),
        ),
      ),
    )
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8")
    })
    child.on("close", (code) => finish(() => resolve({ code, stderr })))
  })
}

export * as PreviewCapture from "./capture"
