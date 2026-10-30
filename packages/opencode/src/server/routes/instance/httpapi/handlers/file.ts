import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { ProjectArchive } from "@/server/project-archive"
import { WorkspaceFile } from "@/server/workspace-file"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { generateText, wrapLanguageModel } from "ai"
import ignore from "ignore"
import path from "path"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { FileDownloadBody } from "../groups/file"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service
    const flags = yield* RuntimeFlags.Service

    const targetPath = Effect.fn("FileHttpApi.targetPath")(function* (
      directory: string,
      input = ".",
      allowRoot = false,
    ) {
      if (!CentralStorage.current()) return path.resolve(directory, input)
      const context = yield* InstanceState.context
      return yield* Effect.tryPromise(async () => {
        const workspace = await CentralStorage.resolveWorkspace(context.directory)
        if (workspace === CentralStorage.workspaceRoot()) {
          throw new CentralStorage.StorageError("outside_root", "Select a project workspace")
        }
        return WorkspaceFile.resolve(workspace, directory, input, allowRoot)
      })
    })

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    const remove = Effect.fn("FileHttpApi.remove")(function* (ctx: { payload: { directory: string; path: string } }) {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const fullPath = yield* targetPath(ctx.payload.directory, ctx.payload.path).pipe(Effect.option)
      if (Option.isNone(fullPath)) return { success: false }
      yield* Effect.promise(() => fs.rm(fullPath.value, { recursive: true, force: true }))
      return { success: true }
    })

    const rename = Effect.fn("FileHttpApi.rename")(function* (ctx: {
      payload: { directory: string; oldPath: string; newPath: string }
    }) {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const absOld = yield* targetPath(ctx.payload.directory, ctx.payload.oldPath).pipe(Effect.option)
      const absNew = yield* targetPath(ctx.payload.directory, ctx.payload.newPath).pipe(Effect.option)
      if (Option.isNone(absOld) || Option.isNone(absNew)) return { success: false }
      const dir = path.dirname(absNew.value)
      if (dir) yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => fs.rename(absOld.value, absNew.value))
      return { success: true }
    })

    const download = Effect.fn("FileHttpApi.download")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.json)
      const decoded = yield* Schema.decodeUnknownEffect(FileDownloadBody)(body).pipe(Effect.option)
      if (Option.isNone(decoded)) return HttpServerResponse.uint8Array(new Uint8Array(), { status: 400 })
      const resolved = yield* targetPath(decoded.value.directory, ".", true).pipe(Effect.option)
      if (Option.isNone(resolved)) return HttpServerResponse.empty({ status: 403 })
      const directory = resolved.value
      const name = `${path.basename(directory) || "project"}.zip`
      const buffer = yield* Effect.promise(() => ProjectArchive.build(directory))
      return HttpServerResponse.uint8Array(new Uint8Array(buffer), {
        contentType: "application/zip",
        headers: { "Content-Disposition": `attachment; filename="${name}"` },
      })
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: {
      payload: { directory: string; path: string; content: string }
    }) {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const fullPath = yield* targetPath(ctx.payload.directory, ctx.payload.path).pipe(Effect.option)
      if (Option.isNone(fullPath)) return { success: false }
      if (!CentralStorage.current() && !FSUtil.contains(ctx.payload.directory, fullPath.value)) {
        yield* Effect.die(new Error("Path escapes the directory"))
      }
      const dir = path.dirname(fullPath.value)
      if (dir) yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(fullPath.value, ctx.payload.content, "utf-8"))
      return { success: true }
    })

    const visualEdit = Effect.fn("FileHttpApi.visualEdit")(function* (ctx: {
      payload: {
        modifiedHtml: string
        changes: ReadonlyArray<{
          selector: string
          type: "css" | "text" | "style" | "attribute" | "html"
          property?: string
          value?: string
          content?: string
          inlineStyle?: string
          sourcePath?: string
        }>
        model?: { providerID: string; modelID: string }
      }
    }) {
      const provider = yield* Provider.Service
      const config = yield* Config.Service
      const cfg = yield* config.get()
      yield* Effect.logInfo("visualEdit: starting", { changesCount: ctx.payload.changes.length })
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const directory = (yield* InstanceState.context).directory
      const projectID = (yield* InstanceState.context).project.id
      yield* Effect.logInfo("visualEdit: resolved directory", { directory })

      const attributionHeaders = (modelID: string): Record<string, string> => {
        const userAgent = { "User-Agent": `omai/${InstallationVersion}` }
        if (!modelID.startsWith("opencode")) {
          return { ...userAgent, "x-session-affinity": `ve-${projectID}`, "X-Session-Id": `ve-${projectID}` }
        }
        return {
          ...userAgent,
          "x-opencode-client": flags.client,
          "x-opencode-session": `ve-${projectID}`,
          "x-opencode-request": `ve-${projectID}`,
        }
      }

      const unresolved: string[] = []
      const resolveCandidates = Effect.fnUntraced(function* () {
        const candidates: { id: string; language: LanguageModelV3 }[] = []
        const push = function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
          const id = `${providerID}/${modelID}`
          // catchCause, not catch: a provider can throw while it loads (e.g. a
          // gateway missing its env), and that must not abort the whole save.
          const language = yield* provider.getModel(providerID, modelID).pipe(
            Effect.flatMap((model) => provider.getLanguage(model)),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                unresolved.push(`${id}: ${errorText(Cause.squash(cause))}`)
                return undefined
              }),
            ),
          )
          if (language && !candidates.some((c) => c.id === id)) candidates.push({ id, language })
        }

        // The model the user is chatting with (chosen, or assigned by an
        // admin) is the only one used: never silently switch to another.
        if (ctx.payload.model) {
          yield* push(ProviderV2.ID.make(ctx.payload.model.providerID), ModelV2.ID.make(ctx.payload.model.modelID))
          return candidates
        }
        if (cfg.visual_editor_model) {
          const parsed = Provider.parseModel(cfg.visual_editor_model)
          yield* push(parsed.providerID, parsed.modelID)
        }

        const predefined = yield* provider.defaultModel().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (predefined) {
          yield* push(predefined.providerID, predefined.modelID)
        }
        for (const modelID of ["hy3-free", "big-pickle", "mimo-v2.5-free"]) {
          yield* push(ProviderV2.ID.make("opencode"), ModelV2.ID.make(modelID))
        }
        return candidates
      })

      const candidates = yield* resolveCandidates()
      yield* Effect.logInfo("visualEdit: resolved model", { models: candidates.map((c) => c.id), unresolved })
      if (candidates.length === 0)
        return {
          success: false,
          filesWritten: [],
          error: unresolved[0] ?? "No usable model: select a model in the chat first",
        }

      yield* Effect.logInfo("visualEdit: resolved language model", { count: candidates.length })

      const sourcePaths = new Set<string>()
      for (const change of ctx.payload.changes) {
        if (change.sourcePath) sourcePaths.add(change.sourcePath)
      }
      if (sourcePaths.size === 0) sourcePaths.add("index.html")

      const readFile = Effect.fnUntraced(function* (fullPath: string) {
        const target = yield* targetPath(directory, fullPath).pipe(Effect.option)
        if (Option.isNone(target)) return ""
        return yield* Effect.promise(() => fs.readFile(target.value, "utf-8").catch(() => ""))
      })

      const sourceFiles: Record<string, string> = {}
      for (const sp of sourcePaths) {
        const fullPath = path.resolve(directory, sp)
        if (!FSUtil.contains(directory, fullPath)) continue
        const content = yield* readFile(fullPath)
        sourceFiles[sp] = content.length > 120_000 ? `${content.slice(0, 120_000)}\n// …(truncated)` : content
      }

      let packageJson = ""
      const pkgPath = path.resolve(directory, "package.json")
      if (FSUtil.contains(directory, pkgPath)) {
        packageJson = yield* readFile(pkgPath)
      }

      const changesDescription = ctx.payload.changes
        .map((c) => {
          const parts = [`Selector: ${c.selector}`]
          if (c.type === "css") parts.push(`CSS property: ${c.property} = ${c.value}`)
          if (c.type === "text") parts.push(`Text content: "${c.content}"`)
          if (c.type === "style") parts.push(`Inline style: ${c.inlineStyle}`)
          if (c.type === "attribute") parts.push(`Attribute ${c.property} = "${c.value}"`)
          if (c.type === "html") parts.push(`Replace the matched element with this HTML: ${c.content}`)
          if (c.sourcePath) parts.push(`Source file: ${c.sourcePath}`)
          return parts.join(", ")
        })
        .join("\n")

      const sourceFilesDescription = Object.entries(sourceFiles)
        .map(([filePath, content]) => `--- ${filePath} ---\n${content}`)
        .join("\n\n")

      const systemPrompt = `You are a code editor that translates visual website changes into source code modifications.

You will receive:
1. A list of visual changes made in a browser preview (CSS properties, text content, inline styles, image/logo/icon replacements)
2. The original source files of the project
3. Optional package.json to determine the framework

Your job: Produce MINIMAL find/replace edits that make the visual changes permanent in the source files.

Rules:
- Identify the framework (React, Next.js, Vue, Svelte, plain HTML, etc.) from the source files and package.json
- For React/Next.js/JSX: modify component source files, not HTML. Use inline styles, className changes, or CSS module edits as appropriate
- For plain HTML: add inline styles to elements and update text content directly
- For CSS files: modify the appropriate CSS rules
- For Tailwind CSS: add/modify Tailwind utility classes instead of inline styles when possible
- Preserve all existing code structure, imports, and formatting
- Make only the smallest change needed - do NOT rewrite entire files
- For attribute changes (e.g. replacing an image "src"): update just the attribute value in the source. New image/logo/icon/SVG files referenced by the new value already exist in the project directory, so reference them exactly by the given URL/path; never fabricate file names.
- For html changes (e.g. an inline SVG icon replaced by an <img>): replace just the matched element in the source with the provided HTML markup.
- For background-image changes on an element, update the matching CSS or inline style.

Respond with a JSON array of edits. Each edit:
{"path": "relative/file/path", "find": "exact text present in the current file", "replace": "exact text to swap in its place"}

Constraints:
- "find" must occur EXACTLY ONCE in the target file. If a short snippet appears more than once, include enough surrounding context (neighboring lines or attributes) to make it unique. Prefer the smallest unique fragment, e.g. just the attribute value being changed or a single line.
- "replace" is the exact text to substitute - make only the intended change, nothing else.
- Only include files that actually changed.
- Return ONLY the JSON array, no other text.`

      const userPrompt = `Visual changes made:\n${changesDescription}\n\nSource files:\n${sourceFilesDescription}\n${packageJson ? `\npackage.json:\n${packageJson}` : ""}`

      const failures: string[] = []
      const callLLM = (system: string, user: string) =>
        Effect.gen(function* () {
          for (const candidate of candidates) {
            // tryPromise, not promise: a rejected call (rate limit, outage)
            // must fall through to the next model instead of aborting the save.
            const output = yield* Effect.tryPromise({
              try: () =>
                generateText({
                  model: wrapLanguageModel({ model: candidate.language, middleware: [] }),
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.1,
                  headers: attributionHeaders(candidate.id),
                  maxRetries: 0,
                  maxOutputTokens: 4096,
                }),
              catch: (error) => error,
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("visualEdit: LLM generation failed", {
                  model: candidate.id,
                  error: String(error),
                }).pipe(
                  Effect.andThen(Effect.sync(() => failures.push(`${candidate.id}: ${errorText(error)}`))),
                  Effect.as(undefined),
                ),
              ),
            )
            if (output) return { model: candidate.id, output }
          }
          return undefined
        })

      yield* Effect.logInfo("visualEdit: calling LLM")
      const generation = yield* callLLM(systemPrompt, userPrompt)
      if (!generation) return { success: false, filesWritten: [], error: failures[0] ?? "The model did not respond" }

      yield* Effect.logInfo("visualEdit: LLM responded", {
        model: generation.model,
        textLength: generation.output.text.length,
      })

      const parseEdits = (raw: string) => {
        const match = raw.trim().match(/\[[\s\S]*\]/)
        if (!match) return undefined
        try {
          return JSON.parse(match[0]) as Array<Record<string, unknown>>
        } catch {
          return undefined
        }
      }

      const rawEdits = parseEdits(generation.output.text)
      if (!rawEdits)
        return { success: false, filesWritten: [], error: `${generation.model} did not return usable edits` }

      const writtenFiles: string[] = []
      const fragmented: Array<{ path: string; reason: string }> = []

      const writeFile = Effect.fnUntraced(function* (fullPath: string, content: string) {
        const target = yield* targetPath(directory, fullPath).pipe(Effect.orDie)
        return yield* Effect.promise(async () => {
          const dir = path.dirname(target)
          if (dir) await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(target, content, "utf-8")
        })
      })

      for (const edit of rawEdits) {
        const editPath = typeof edit.path === "string" ? edit.path : undefined
        if (!editPath) continue
        const fullPath = path.resolve(directory, editPath)
        if (!FSUtil.contains(directory, fullPath)) continue

        if (typeof edit.content === "string") {
          yield* writeFile(fullPath, edit.content)
          writtenFiles.push(editPath)
          continue
        }

        if (typeof edit.find !== "string" || typeof edit.replace !== "string") {
          fragmented.push({ path: editPath, reason: "missing-find-replace" })
          continue
        }

        const content = yield* readFile(fullPath)
        const occurrences = content.split(edit.find).length - 1
        if (occurrences !== 1) {
          fragmented.push({ path: editPath, reason: occurrences === 0 ? "not-found" : "ambiguous" })
          continue
        }
        yield* writeFile(fullPath, content.replace(edit.find, edit.replace))
        writtenFiles.push(editPath)
      }

      const failedPaths = [...new Set(fragmented.map((e) => e.path))]
      if (failedPaths.length > 0) {
        yield* Effect.logWarning("visualEdit: snippet apply failed, retrying full-file rewrite", {
          failed: fragmented,
        })
        const fallbackFiles: Array<{ path: string; content: string }> = []
        for (const failedPath of failedPaths) {
          const fullPath = path.resolve(directory, failedPath)
          if (FSUtil.contains(directory, fullPath)) {
            fallbackFiles.push({ path: failedPath, content: yield* readFile(fullPath) })
          }
        }
        if (fallbackFiles.length > 0) {
          const fallbackSystem = `You are a code editor. You will receive source files and a list of visual changes.
Reproduce each file's FULL new content with ONLY the listed changes applied.
Preserve all structure, imports, and formatting; change as little as possible.

Respond with a JSON array: [{"path": "relative/file/path", "content": "full new file content"}]
Return ONLY the JSON array, no other text.`
          const fallbackUser = `Files to update:\n${fallbackFiles
            .map((f) => `--- ${f.path} ---\n${f.content}`)
            .join("\n\n")}\n\nVisual changes:\n${changesDescription}`

          const fallback = yield* callLLM(fallbackSystem, fallbackUser)
          const fallbackEdits = fallback ? parseEdits(fallback.output.text) : undefined
          if (fallbackEdits) {
            for (const edit of fallbackEdits) {
              const editPath = typeof edit.path === "string" ? edit.path : undefined
              if (!editPath || typeof edit.content !== "string") continue
              const fullPath = path.resolve(directory, editPath)
              if (!FSUtil.contains(directory, fullPath)) continue
              yield* writeFile(fullPath, edit.content)
              if (!writtenFiles.includes(editPath)) writtenFiles.push(editPath)
            }
            yield* Effect.logInfo("visualEdit: fallback applied", { model: fallback?.model })
          }
        }
      }

      yield* Effect.logInfo("visualEdit: done", {
        filesWritten: writtenFiles,
        unresolved: failedPaths.filter((p) => !writtenFiles.includes(p)),
      })

      if (writtenFiles.length === 0)
        return {
          success: false,
          filesWritten: [],
          error: `${generation.model} could not match the change to the source files`,
        }
      return { success: true, filesWritten: writtenFiles }
    })

    const visualEditSafe: typeof visualEdit = (ctx) =>
      visualEdit(ctx).pipe(
        Effect.catchDefect((defect) => {
          console.error("[visualEdit] Defect caught:", defect)
          return Effect.succeed({
            success: false,
            filesWritten: [],
            error: defect instanceof Error ? defect.message : "Saving the visual edit failed",
          })
        }),
      )

    const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

    const upload = Effect.fn("FileHttpApi.upload")(function* (ctx: { payload: { fileName: string; content: string } }) {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const directory = (yield* InstanceState.context).directory

      const safeName = path.basename(ctx.payload.fileName).replace(/[\\/]/g, "")
      if (!safeName || !/\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(safeName)) {
        return { success: false, path: "", url: "" }
      }

      const bytes = Buffer.from(ctx.payload.content ?? "", "base64")
      if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
        return { success: false, path: "", url: "" }
      }

      const publicDir = path.join(directory, "public")
      const hasPublic = yield* Effect.promise(() =>
        fs
          .stat(publicDir)
          .then((s) => s.isDirectory())
          .catch(() => false),
      )
      const dir = hasPublic ? publicDir : directory
      const fullPath = yield* targetPath(directory, path.join(dir, safeName)).pipe(Effect.option)
      if (Option.isNone(fullPath) || !FSUtil.contains(directory, fullPath.value)) {
        return { success: false, path: "", url: "" }
      }

      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(fullPath.value, bytes))

      return {
        success: true,
        path: hasPublic ? `public/${safeName}` : safeName,
        url: `/${safeName}`,
      }
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
      .handle("remove", remove)
      .handle("rename", rename)
      .handleRaw("download", download)
      .handle("write", write)
      .handle("visualEdit", visualEditSafe)
      .handle("upload", upload)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
