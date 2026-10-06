export * as CentralStorage from "./central"

import path from "node:path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { Schema } from "effect"

export interface Config {
  readonly root: string
  /** The provisioned volume is also the unit of infrastructure fencing. */
  readonly id: string
}

export class StorageError extends Error {
  readonly _tag = "CentralStorage.StorageError"
  constructor(
    readonly code: "configuration" | "unavailable" | "identity" | "outside_root",
    message: string,
  ) {
    super(message)
    this.name = "CentralStorage.StorageError"
  }
}

export const markerName = ".opencode-volume.json"
const Marker = Schema.Struct({ version: Schema.Literal(1), id: Schema.String })
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(Marker))
const identities = new WeakMap<Config, { dev: number; ino: number; mount: string }>()

export function configure(env: Record<string, string | undefined>): Config | undefined {
  const mode = env.OPENCODE_STORAGE_MODE ?? "local"
  if (mode !== "local" && mode !== "central")
    throw new StorageError("configuration", "OPENCODE_STORAGE_MODE must be local or central")
  if (mode === "local") {
    if (env.OPENCODE_STORAGE_ROOT || env.OPENCODE_STORAGE_ID)
      throw new StorageError("configuration", "Storage root and ID require OPENCODE_STORAGE_MODE=central")
    return
  }
  const root = env.OPENCODE_STORAGE_ROOT
  const id = env.OPENCODE_STORAGE_ID
  if (!root || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root)
    throw new StorageError("configuration", "Central storage requires a non-root absolute OPENCODE_STORAGE_ROOT")
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    throw new StorageError("configuration", "Central storage requires a valid OPENCODE_STORAGE_ID")
  if (env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG)
    throw new StorageError("configuration", "Central storage does not permit local config path overrides")
  return Object.freeze({ root: path.resolve(root), id })
}

const selected = configure(process.env)

export const current = () => selected
export const workspaceRoot = (config = selected) => (config ? path.join(config.root, "workspaces") : undefined)

const contains = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Parse Linux mountinfo rather than assuming that an existing directory is a mounted volume. */
export function mountedAt(root: string, mountInfo: string) {
  const entry = mountInfo.split("\n").find((line) => {
    const fields = line.split(" ")
    return (
      fields.length > 5 &&
      fields[4].replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))) === root
    )
  })
  if (!entry) throw new StorageError("unavailable", "Central storage root is not a mounted volume")
  const fields = entry.split(" ")
  if (!fields[5].split(",").includes("rw")) throw new StorageError("unavailable", "Central storage volume is read-only")
  return fields[0]
}

/** Check actual filesystem identity. Supplying mountinfo is for offline verification and tests. */
export async function verify(config: Config, mountInfo: string) {
  const mount = mountedAt(config.root, mountInfo)
  const root = await fs.realpath(config.root)
  if (root !== config.root) throw new StorageError("identity", "Central storage root must be canonical, not a symlink")
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new StorageError("unavailable", "Central storage root is not a directory")
  const identity = identities.get(config)
  if (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino || identity.mount !== mount))
    throw new StorageError("identity", "Central storage mount changed; the runtime must be restarted")
  const file = await fs.open(path.join(root, markerName), constants.O_RDONLY | constants.O_NOFOLLOW)
  const marker = await (async () => {
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 4096 || info.nlink !== 1)
        throw new StorageError("identity", "Invalid central storage identity marker")
      return decodeMarker(await file.readFile("utf8"))
    } finally {
      await file.close()
    }
  })()
  if (marker.id !== config.id) throw new StorageError("identity", "Central storage volume identity does not match")
  identities.set(config, { dev: stat.dev, ino: stat.ino, mount })
}

/** This validates placement, not fencing: infrastructure must revoke the previous writer first. */
export async function check(config = selected): Promise<void> {
  if (!config) return
  try {
    await verify(config, await fs.readFile("/proc/self/mountinfo", "utf8"))
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError("unavailable", "Central storage could not be verified; refusing filesystem operations")
  }
}

async function canonicalTarget(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (cause) {
    if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) throw cause
    // A broken symlink is not a missing path beneath a safe ancestor.
    const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (entry?.isSymbolicLink()) throw new StorageError("outside_root", "Broken symlink in workspace path")
    const parent = path.dirname(target)
    if (parent === target) throw cause
    const canonical = await canonicalTarget(parent)
    const info = await fs.stat(canonical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info && !info.isDirectory()) throw new StorageError("outside_root", "Workspace ancestor is not a directory")
    return path.join(canonical, path.basename(target))
  }
}

/** Resolve existing or prospective paths under a trusted root; callers still authorize workspace membership. */
export async function resolveUnder(root: string, input: string) {
  if (!path.isAbsolute(input)) throw new StorageError("outside_root", "An absolute workspace path is required")
  const target = path.resolve(input)
  if (!contains(root, target)) throw new StorageError("outside_root", "Path is outside the assigned storage root")
  const canonicalRoot = await fs.realpath(root)
  if (canonicalRoot !== root) throw new StorageError("outside_root", "Assigned storage root must not be a symlink")
  const canonical = await canonicalTarget(target)
  if (!contains(canonicalRoot, canonical))
    throw new StorageError("outside_root", "Path escapes the assigned storage root")
  return canonical
}

export async function resolveWorkspace(input: string, config = selected) {
  if (!config) return path.resolve(input)
  await check(config)
  return resolveUnder(path.join(config.root, "workspaces"), input)
}

export const assertWorkspace = resolveWorkspace

export async function resolveManaged(input: string, config = selected) {
  if (!config) return path.resolve(input)
  await check(config)
  return resolveUnder(config.root, input)
}

/** Run only during operator provisioning, before starting any application or shell process. */
export async function provision(config: Config) {
  mountedAt(config.root, await fs.readFile("/proc/self/mountinfo", "utf8"))
  if ((await fs.realpath(config.root)) !== config.root)
    throw new StorageError("identity", "Central storage root must be canonical, not a symlink")
  const marker = path.join(config.root, markerName)
  await fs
    .writeFile(marker, JSON.stringify({ version: 1, id: config.id }) + "\n", { flag: "wx", mode: 0o444 })
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause
    })
  await check(config)
  for (const name of ["data", "config", "state", "workspaces", "home", "cache"]) {
    const target = await resolveUnder(config.root, path.join(config.root, name))
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
  }
}
