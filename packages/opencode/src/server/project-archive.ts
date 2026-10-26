import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises"
import path from "node:path"
import type { Entry } from "@zip.js/zip.js"

// Limits apply to actual streamed bytes as well as the untrusted ZIP metadata.
export const limits = {
  archiveBytes: 200 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  expandedBytes: 1024 * 1024 * 1024,
  entries: 50_000,
  pathBytes: 4096,
  linkBytes: 4096,
} as const

const vcs = new Set([".git", ".hg", ".svn"])
const caches = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".npm",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".venv",
])
const privateDirectories = new Set([".ssh", ".aws", ".gnupg", ".secrets"])
const privateFiles = new Set([
  ".netrc",
  ".git-credentials",
  ".npmrc",
  "auth.json",
  "mcp-auth.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
])

// Search ignores deliberately do not apply here: bin, desktop, build, dist,
// vendor, and generated assets can all be necessary parts of a source tree.
function excluded(name: string) {
  const parts = name.split("/")
  if (parts.some((part) => vcs.has(part) || caches.has(part) || privateDirectories.has(part))) return true
  const base = parts.at(-1)!
  if (privateFiles.has(base)) return true
  if (/^\.env(?:\.|$)/.test(base) && !/\.(?:example|sample|template)$/.test(base)) return true
  return (
    /(?:^|\/)\.yarn\/(?:cache|unplugged)(?:\/|$)/.test(name) ||
    /(?:^|\/)\.docker\/config\.json$/.test(name) ||
    /(?:^|\/)\.kube\/config$/.test(name) ||
    /^deploy\/central\/secrets(?:\/|$)/.test(name)
  )
}

export async function build(directory: string): Promise<Buffer> {
  const { ZipWriter, Uint8ArrayReader } = await import("@zip.js/zip.js")
  const root = await realpath(directory)
  const base = path.basename(root) || "project"
  const chunks: Buffer[] = []
  let compressed = 0
  let expanded = 0
  let count = 0
  const links: { name: string; target: string }[] = []
  const zip = new ZipWriter(
    new WritableStream<Uint8Array>({
      write(chunk) {
        compressed += chunk.byteLength
        if (compressed > limits.archiveBytes) throw new Error("Project ZIP exceeds 200 MiB")
        chunks.push(Buffer.from(chunk))
      },
    }),
    { level: 6 },
  )
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()!
    if ((await realpath(directory)) !== directory) throw new Error("Project directory changed during export")
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (excluded(relative)) continue
      safeName(relative)
      if (++count > limits.entries) throw new Error("Project ZIP exceeds 50000 entries")
      const info = await lstat(absolute)
      const options = {
        useWebWorkers: false,
        versionMadeBy: 0x0314,
        externalFileAttributes: (info.mode << 16) >>> 0,
        lastModDate: info.mtime,
      }
      const name = `${base}/${relative}`
      if (info.isDirectory()) {
        await zip.add(`${name}/`, undefined, { ...options, directory: true })
        stack.push(absolute)
        continue
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        safeLink(relative, target)
        links.push({ name: relative, target })
        const data = Buffer.from(target)
        expanded += data.length
        if (expanded > limits.expandedBytes) throw new Error("Project ZIP exceeds 1 GiB expanded")
        await zip.add(
          name,
          new Uint8ArrayReader(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
          options,
        )
        continue
      }
      if (!info.isFile()) throw new Error(`Unsupported project file type: ${relative}`)
      if (info.size > limits.fileBytes) throw new Error(`Project file exceeds 256 MiB: ${relative}`)
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const current = await file.stat()
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
          throw new Error(`Project file changed during export: ${relative}`)
        }
        let size = 0
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = new Uint8Array(64 * 1024)
            const { bytesRead } = await file.read(chunk)
            if (!bytesRead) return controller.close()
            size += bytesRead
            expanded += bytesRead
            if (size > limits.fileBytes || expanded > limits.expandedBytes) {
              throw new Error("Project ZIP exceeds expanded size limits")
            }
            controller.enqueue(chunk.subarray(0, bytesRead))
          },
        })
        await zip.add(name, stream, options)
        const after = await file.stat()
        if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
          throw new Error(`Project file changed during export: ${relative}`)
        }
      } finally {
        await file.close()
      }
    }
  }
  validateLinks(links)
  await zip.close()
  return Buffer.concat(chunks)
}

export async function extract(data: Uint8Array, destination: string): Promise<number> {
  if (data.byteLength > limits.archiveBytes) throw new Error("Zip file must be under 200 MiB")
  const { ZipReader, Uint8ArrayReader } = await import("@zip.js/zip.js")
  // Buffer.slice() creates views, while this reader requires Uint8Array.slice()
  // copies when reading headers; normalize the view without copying the ZIP.
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, checkSignature: true })
  let staging: string | undefined
  try {
    const entries = await inventory(zip.getEntriesGenerator())
    const root = commonRoot(entries)
    const files = entries.map((item) => ({ ...item, name: item.name.slice(root.length) })).filter((item) => item.name)
    validatePaths(files)
    const target = path.resolve(destination)
    const parent = await prepareParent(target)
    await assertEmptyDestination(target)
    // Stage inside the target so files are moved on the same filesystem
    // (the target may be a separate volume mount, which forbids cross-device
    // rename from the parent directory).
    await mkdir(target, { recursive: true })
    // Stage in the parent so a non-writable target (e.g. a volume mount point
    // owned by another user) does not block extraction; the parent and target
    // share a filesystem, so the final rename stays atomic.
    staging = await mkdtemp(path.join(path.dirname(target), ".omai-import-"))
    const links: { name: string; target: string }[] = []
    let expanded = 0
    let count = 0
    for (const item of files) {
      const output = path.join(staging, item.name)
      if (item.kind === "directory") {
        await mkdir(output, { recursive: true })
        continue
      }
      await mkdir(path.dirname(output), { recursive: true })
      const chunks: Buffer[] = []
      const file = item.kind === "file" ? await open(output, "wx", 0o600) : undefined
      let size = 0
      try {
        if (!item.entry.getData) throw new Error(`ZIP entry has no data: ${item.name}`)
        await item.entry.getData(
          new WritableStream<Uint8Array>({
            async write(chunk) {
              size += chunk.byteLength
              expanded += chunk.byteLength
              if (
                size > item.entry.uncompressedSize ||
                size > limits.fileBytes ||
                expanded > limits.expandedBytes ||
                (item.kind === "link" && size > limits.linkBytes)
              ) {
                throw new Error("ZIP exceeds expanded size limits")
              }
              if (file) await file.writeFile(chunk)
              else chunks.push(Buffer.from(chunk))
            },
          }),
        )
        if (size !== item.entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${item.name}`)
        if (file) {
          await file.chmod(item.mode)
          if (Number.isFinite(item.entry.lastModDate.getTime()))
            await file.utimes(item.entry.lastModDate, item.entry.lastModDate)
        }
        if (item.kind === "link") {
          const target = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
          safeLink(item.name, target)
          links.push({ name: item.name, target })
        }
      } finally {
        await file?.close()
      }
      count++
    }
    // Links are created only after every regular file has been written. No
    // archive entry can traverse a symlink, including one introduced earlier.
    validateLinks(links)
    for (const link of links) await symlink(link.target, path.join(staging, link.name))
    for (const item of files
      .filter((item) => item.kind === "directory")
      .sort((a, b) => b.name.length - a.name.length)) {
      await chmod(path.join(staging, item.name), item.mode)
      if (Number.isFinite(item.entry.lastModDate.getTime())) {
        await utimes(path.join(staging, item.name), item.entry.lastModDate, item.entry.lastModDate)
      }
    }
    await assertEmptyDestination(target)
    if ((await realpath(parent)) !== parent) throw new Error("Project destination changed during import")
    // The destination may be a pre-existing volume mount point (MicroVM),
    // which cannot be replaced by rename. Materialise it and move the staged
    // contents into it instead.
    await mkdir(target, { recursive: true })
    const stagedEntries = await readdir(staging)
    for (const entry of stagedEntries) {
      await rename(path.join(staging, entry), path.join(target, entry))
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    staging = undefined
    return count
  } finally {
    await zip.close()
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}

type Item = { entry: Entry; name: string; kind: "file" | "directory" | "link"; mode: number }

async function inventory(source: AsyncIterable<Entry>): Promise<Item[]> {
  const items: Item[] = []
  const names = new Set<string>()
  let count = 0
  let expanded = 0
  for await (const entry of source) {
    if (++count > limits.entries) throw new Error("ZIP exceeds 50000 entries")
    const name = safeName(entry.filename)
    if (names.has(name)) throw new Error(`Duplicate ZIP path: ${name}`)
    names.add(name)
    if (entry.encrypted || ![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported ZIP entry: ${name}`)
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > limits.fileBytes
    ) {
      throw new Error(`ZIP entry exceeds 256 MiB: ${name}`)
    }
    expanded += entry.uncompressedSize
    if (expanded > limits.expandedBytes) throw new Error("ZIP exceeds 1 GiB expanded")
    const unix = entry.versionMadeBy >> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0
    const type = unix & 0o170000
    if (![0, 0o100000, 0o040000, 0o120000].includes(type)) throw new Error(`Unsupported ZIP file type: ${name}`)
    const kind = type === 0o120000 ? "link" : entry.directory ? "directory" : "file"
    if (
      (kind === "link" && (entry.directory || entry.uncompressedSize > limits.linkBytes)) ||
      (kind === "directory" && (entry.uncompressedSize !== 0 || (type !== 0 && type !== 0o040000)))
    ) {
      throw new Error(`Inconsistent ZIP file type: ${name}`)
    }
    // Import always starts a fresh repository (see gitInitRepo), so drop
    // uploaded VCS metadata instead of rejecting the archive.
    if (name.split("/").some((part) => vcs.has(part.toLowerCase()))) continue
    if (name === "__MACOSX" || name.startsWith("__MACOSX/")) continue
    items.push({ entry, name, kind, mode: unix ? unix & 0o777 : kind === "directory" ? 0o755 : 0o644 })
  }
  return items
}

function commonRoot(items: Item[]) {
  const first = items[0]?.name.split("/")[0]
  if (!first || !items.some((item) => item.name.startsWith(`${first}/`))) return ""
  return items.every((item) => item.name.startsWith(`${first}/`) || (item.name === first && item.kind === "directory"))
    ? `${first}/`
    : ""
}

function validatePaths(items: Item[]) {
  const names = new Map<string, string>()
  const kinds = new Map(items.map((item) => [item.name, item.kind]))
  for (const item of items) {
    const parts = item.name.split("/")
    for (let index = 1; index <= parts.length; index++) {
      const name = parts.slice(0, index).join("/")
      const key = name.normalize("NFC").toLowerCase()
      const prior = names.get(key)
      if (prior && prior !== name) throw new Error(`Colliding ZIP paths: ${prior}, ${name}`)
      names.set(key, name)
      if (index < parts.length && kinds.has(name) && kinds.get(name) !== "directory") {
        throw new Error(`ZIP path traverses a file or symlink: ${name}`)
      }
    }
  }
}

function safeName(value: string) {
  const name = value.endsWith("/") ? value.slice(0, -1) : value
  if (
    !name ||
    Buffer.byteLength(name) > limits.pathBytes ||
    /[\\\x00-\x1f:]/.test(name) ||
    name
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  ) {
    throw new Error(`Unsafe ZIP path: ${value}`)
  }
  return name
}

function safeLink(name: string, target: string) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
  if (
    !target ||
    Buffer.byteLength(target) > limits.linkBytes ||
    /[\\\x00-\x1f:]/.test(target) ||
    path.posix.isAbsolute(target) ||
    resolved === ".." ||
    resolved.startsWith("../")
  ) {
    throw new Error(`Unsafe ZIP symlink: ${name}`)
  }
}

function validateLinks(links: { name: string; target: string }[]) {
  const targets = new Map(links.map((link) => [link.name, link.target]))
  for (const link of links) {
    const pending = [...path.posix.dirname(link.name).split("/"), ...link.target.split("/")]
    const resolved: string[] = []
    let followed = 0
    while (pending.length) {
      const part = pending.shift()!
      if (!part || part === ".") continue
      if (part === "..") {
        if (!resolved.length) throw new Error(`Unsafe ZIP symlink chain: ${link.name}`)
        resolved.pop()
        continue
      }
      resolved.push(part)
      const target = targets.get(resolved.join("/"))
      if (target === undefined) continue
      if (++followed > 40) throw new Error(`Cyclic ZIP symlink: ${link.name}`)
      resolved.pop()
      pending.unshift(...target.split("/"))
    }
  }
}

export async function assertEmptyDestination(target: string) {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return
  // Fresh ext4 volume mount points contain a `lost+found` directory owned by
  // root. Staging directories (.omai-import-*) may also be present from a
  // previous interrupted import. Treat a directory containing only those
  // entries as empty so project creation can proceed on MicroVM-backed volumes.
  const entries = (await readdir(target)).filter(
    (name) => name !== "lost+found" && !name.startsWith(".omai-import-"),
  )
  if (!info.isDirectory() || entries.length)
    throw new Error("Project destination must be a new or empty directory")
}

async function prepareParent(target: string) {
  const parent = path.dirname(target)
  let existing = parent
  while (
    !(await lstat(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }))
  )
    existing = path.dirname(existing)
  if ((await realpath(existing)) !== existing || !(await lstat(existing)).isDirectory()) {
    throw new Error("Project destination contains a symlink")
  }
  await mkdir(parent, { recursive: true })
  if ((await realpath(parent)) !== parent) throw new Error("Project destination contains a symlink")
  return parent
}

export * as ProjectArchive from "./project-archive"
