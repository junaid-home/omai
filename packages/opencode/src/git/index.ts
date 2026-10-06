import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer, Context, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    truncated: false,
  }) satisfies Result

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export type Branch = {
  readonly name: string
  readonly current: boolean
  readonly remote: boolean
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
}

export type Remote = {
  readonly name: string
  readonly url: string
}

export type Commit = {
  readonly hash: string
  readonly short: string
  readonly subject: string
  readonly body: string
  readonly author: string
  readonly email: string
  readonly date: number
  readonly parents: readonly string[]
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: ChildProcess.CommandInput
}

export interface CommitInput {
  readonly message: string
  readonly amend?: boolean
  readonly all?: boolean
}

export interface LogInput {
  readonly limit?: number
  readonly ref?: string
}

export interface PushInput {
  readonly remote?: string
  readonly branch?: string
  readonly setUpstream?: boolean
  readonly force?: boolean
}

export interface PullInput {
  readonly remote?: string
  readonly branch?: string
  readonly rebase?: boolean
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
  readonly patch: (cwd: string, ref: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchAll: (cwd: string, ref: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchUntracked: (cwd: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly statUntracked: (cwd: string, file: string) => Effect.Effect<Stat | undefined>
  readonly applyPatch: (cwd: string, patch: string) => Effect.Effect<Result>
  readonly remotes: (cwd: string) => Effect.Effect<Remote[]>
  readonly addRemote: (cwd: string, name: string, url: string) => Effect.Effect<Result>
  readonly setRemoteUrl: (cwd: string, name: string, url: string) => Effect.Effect<Result>
  readonly removeRemote: (cwd: string, name: string) => Effect.Effect<Result>
  readonly branches: (cwd: string) => Effect.Effect<Branch[]>
  readonly createBranch: (cwd: string, name: string, from?: string) => Effect.Effect<Result>
  readonly deleteBranch: (cwd: string, name: string, force?: boolean) => Effect.Effect<Result>
  readonly checkout: (cwd: string, name: string) => Effect.Effect<Result>
  readonly commit: (cwd: string, input: CommitInput) => Effect.Effect<Result>
  readonly log: (cwd: string, input: LogInput) => Effect.Effect<Commit[]>
  readonly push: (cwd: string, input: PushInput) => Effect.Effect<Result>
  readonly pull: (cwd: string, input: PullInput) => Effect.Effect<Result>
  readonly restore: (cwd: string, files: readonly string[]) => Effect.Effect<Result>
  readonly untracked: (cwd: string, files: readonly string[]) => Effect.Effect<Result>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Git") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const encoder = new TextEncoder()
    const stdin = (text: string) => Stream.make(encoder.encode(text))

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", [...cfg, ...args], {
            cwd: opts.cwd,
            env: opts.env,
            extendEnv: true,
            stdin: opts.stdin ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
          { maxOutputBytes: opts.maxOutputBytes },
        )
        return {
          exitCode: result.exitCode,
          text: () => result.stdout.toString("utf8"),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated || result.stderrTruncated,
        } satisfies Result
      },
      Effect.catch((err) => Effect.succeed(fail(err))),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies Stat,
        ]
      })
    })

    const patch = Effect.fn("Git.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Git.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", "."],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchUntracked = Effect.fn("Git.patchUntracked")(function* (
      cwd: string,
      file: string,
      options?: PatchOptions,
    ) {
      const result = yield* run(
        [
          "diff",
          "--no-index",
          "--patch",
          "--no-ext-diff",
          "--no-renames",
          `--unified=${options?.context ?? 3}`,
          "--",
          "/dev/null",
          file,
        ],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const statUntracked = Effect.fn("Git.statUntracked")(function* (cwd: string, file: string) {
      const result = yield* run(["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
        cwd,
        maxOutputBytes: 4096,
      })

      if (result.truncated) return
      const text = result.text()

      const parts = text.split("\t")
      if (parts.length < 2) return

      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] || "0", 10)
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] || "0", 10)
      return {
        file,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      } satisfies Stat
    })

    const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["apply", "-"], { cwd, stdin: stdin(patch) })
    })

    const remotes = Effect.fn("Git.remotes")(function* (cwd: string) {
      return (yield* lines(["remote", "-v"], { cwd })).flatMap((line) => {
        const tab = line.indexOf("\t")
        if (tab === -1) return []
        const name = line.slice(0, tab).trim()
        const target = line.slice(tab + 1).trim()
        if (!name || !target.endsWith(" (fetch)")) return []
        return [{ name, url: target.slice(0, -" (fetch)".length) } satisfies Remote]
      })
    })

    const addRemote = Effect.fn("Git.addRemote")(function* (cwd: string, name: string, url: string) {
      return yield* run(["remote", "add", name, url], { cwd })
    })

    const setRemoteUrl = Effect.fn("Git.setRemoteUrl")(function* (cwd: string, name: string, url: string) {
      return yield* run(["remote", "set-url", name, url], { cwd })
    })

    const removeRemote = Effect.fn("Git.removeRemote")(function* (cwd: string, name: string) {
      return yield* run(["remote", "remove", name], { cwd })
    })

    const branches = Effect.fn("Git.branches")(function* (cwd: string) {
      const current = yield* branch(cwd)
      const rows = yield* lines(
        ["for-each-ref", "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)", "refs/heads"],
        { cwd },
      )
      return rows.map((row) => {
        const [name, upstream, track] = row.split("\0")
        return {
          name: name ?? "",
          current: name === current,
          remote: false,
          upstream: upstream || undefined,
          ahead: trackCount(track, "ahead"),
          behind: trackCount(track, "behind"),
        } satisfies Branch
      })
    })

    const invalidBranch = Effect.fnUntraced(function* (cwd: string, name: string) {
      if (!name.trim()) return fail(new Error("Branch name is required"))
      const result = yield* run(["check-ref-format", "--branch", name], { cwd })
      if (result.exitCode !== 0) return fail(new Error(`Invalid branch name: ${name}`))
      return undefined
    })

    const createBranch = Effect.fn("Git.createBranch")(function* (cwd: string, name: string, from?: string) {
      const invalid = yield* invalidBranch(cwd, name)
      if (invalid) return invalid
      if (from) {
        const invalidFrom = yield* invalidBranch(cwd, from)
        if (invalidFrom) return invalidFrom
      }
      return yield* run(["checkout", "-b", name, ...(from ? [from] : [])], { cwd })
    })

    const deleteBranch = Effect.fn("Git.deleteBranch")(function* (cwd: string, name: string, force?: boolean) {
      const invalid = yield* invalidBranch(cwd, name)
      if (invalid) return invalid
      return yield* run(["branch", force ? "-D" : "-d", name], { cwd })
    })

    const checkout = Effect.fn("Git.checkout")(function* (cwd: string, name: string) {
      const invalid = yield* invalidBranch(cwd, name)
      if (invalid) return invalid
      return yield* run(["checkout", name], { cwd })
    })

    const commit = Effect.fn("Git.commit")(function* (cwd: string, input: CommitInput) {
      const message = input.message.trim()
      if (!message) return fail(new Error("Commit message is required"))
      const identity = yield* Effect.all(
        [run(["config", "user.name"], { cwd }), run(["config", "user.email"], { cwd })],
        {
          concurrency: 2,
        },
      )
      if (!out(identity[0]) || !out(identity[1]))
        return fail(
          new Error(
            'Git user.name and user.email must be configured before committing. Run `git config user.name "Your Name"` and `git config user.email "you@example.com"`.',
          ),
        )
      if (input.all) {
        const staged = yield* run(["add", "--all", "--", "."], { cwd })
        if (staged.exitCode !== 0) return staged
      }
      return yield* run(["commit", "--message", message, ...(input.amend ? ["--amend"] : [])], { cwd })
    })

    const log = Effect.fn("Git.log")(function* (cwd: string, input: LogInput) {
      const result = yield* run(
        [
          "log",
          `--max-count=${input.limit ?? 50}`,
          "--format=%x1e%x1f%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%P",
          ...(input.ref ? [input.ref] : []),
        ],
        { cwd, maxOutputBytes: 2_000_000 },
      )
      if (result.exitCode !== 0) return []
      return result
        .text()
        .split("\x1e")
        .map((record) => record.replace(/^\x1f/, "").trim())
        .filter((record) => record.length > 0)
        .map((record) => {
          const [hash, short, subject, body, author, email, at, parents] = record.split("\x1f")
          const seconds = Number.parseInt(at ?? "0", 10)
          return {
            hash: hash ?? "",
            short: short ?? "",
            subject: subject ?? "",
            body: (body ?? "").trim(),
            author: author ?? "",
            email: email ?? "",
            date: (Number.isFinite(seconds) ? seconds : 0) * 1000,
            parents: (parents ?? "").split(" ").filter(Boolean),
          } satisfies Commit
        })
    })

    const push = Effect.fn("Git.push")(function* (cwd: string, input: PushInput) {
      return yield* run(
        [
          "push",
          ...(input.setUpstream ? ["--set-upstream"] : []),
          ...(input.force ? ["--force"] : []),
          input.remote ?? "origin",
          input.branch ?? "HEAD",
        ],
        { cwd, maxOutputBytes: 2_000_000 },
      )
    })

    const pull = Effect.fn("Git.pull")(function* (cwd: string, input: PullInput) {
      return yield* run(
        [
          "pull",
          input.rebase === false ? "--no-rebase" : "--rebase",
          ...(input.remote ? [input.remote] : []),
          ...(input.branch ? [input.branch] : []),
        ],
        { cwd, maxOutputBytes: 2_000_000 },
      )
    })

    const restore = Effect.fn("Git.restore")(function* (cwd: string, files: readonly string[]) {
      if (files.length === 0) return yield* run(["checkout", "HEAD", "--", "."], { cwd })
      return yield* run(["checkout", "HEAD", "--", ...files], { cwd })
    })

    const untracked = Effect.fn("Git.untracked")(function* (cwd: string, files: readonly string[]) {
      if (files.length === 0) return yield* run(["clean", "-f", "--", "."], { cwd })
      return yield* run(["clean", "-f", "--", ...files], { cwd })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      status,
      diff,
      stats,
      patch,
      patchAll,
      patchUntracked,
      statUntracked,
      applyPatch,
      remotes,
      addRemote,
      setRemoteUrl,
      removeRemote,
      branches,
      createBranch,
      deleteBranch,
      checkout,
      commit,
      log,
      push,
      pull,
      restore,
      untracked,
    })
  }),
)

const trackCount = (track: string | undefined, kind: "ahead" | "behind") => {
  const match = new RegExp(`${kind} (\\d+)`).exec(track ?? "")
  const value = match ? Number.parseInt(match[1] ?? "0", 10) : 0
  return Number.isFinite(value) ? value : 0
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AppProcess.node] })

export * as Git from "."
