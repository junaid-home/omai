import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Scope } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "@/git"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { VcsEvent } from "@opencode-ai/schema/vcs-event"

const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = VcsEvent

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export const Branch = Schema.Struct({
  name: Schema.String,
  current: Schema.Boolean,
  remote: Schema.Boolean,
  upstream: Schema.optional(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
}).annotate({ identifier: "VcsBranch" })
export type Branch = Schema.Schema.Type<typeof Branch>

export const Remote = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
}).annotate({ identifier: "VcsRemote" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const AddRemoteInput = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
})
export type AddRemoteInput = Schema.Schema.Type<typeof AddRemoteInput>

export const SetRemoteInput = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
})
export type SetRemoteInput = Schema.Schema.Type<typeof SetRemoteInput>

export const RemoveRemoteInput = Schema.Struct({
  name: Schema.String,
})
export type RemoveRemoteInput = Schema.Schema.Type<typeof RemoveRemoteInput>

export const Commit = Schema.Struct({
  hash: Schema.String,
  short: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  author: Schema.String,
  email: Schema.String,
  date: Schema.Number,
  parents: Schema.Array(Schema.String),
}).annotate({ identifier: "VcsCommit" })
export type Commit = Schema.Schema.Type<typeof Commit>

export const CreateBranchInput = Schema.Struct({
  name: Schema.String,
  from: Schema.optional(Schema.String),
})
export type CreateBranchInput = Schema.Schema.Type<typeof CreateBranchInput>

export const DeleteBranchInput = Schema.Struct({
  name: Schema.String,
  force: Schema.optional(Schema.Boolean),
})
export type DeleteBranchInput = Schema.Schema.Type<typeof DeleteBranchInput>

export const CheckoutInput = Schema.Struct({
  name: Schema.String,
})
export type CheckoutInput = Schema.Schema.Type<typeof CheckoutInput>

export const CommitInput = Schema.Struct({
  message: Schema.String,
  amend: Schema.optional(Schema.Boolean),
})
export type CommitInput = Schema.Schema.Type<typeof CommitInput>

export const LogInput = Schema.Struct({
  limit: Schema.optional(Schema.Number),
})
export type LogInput = Schema.Schema.Type<typeof LogInput>

export const PushInput = Schema.Struct({
  remote: Schema.optional(Schema.String),
  setUpstream: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
})
export type PushInput = Schema.Schema.Type<typeof PushInput>

export const PullInput = Schema.Struct({
  rebase: Schema.optional(Schema.Boolean),
})
export type PullInput = Schema.Schema.Type<typeof PullInput>

export const DiscardInput = Schema.Struct({
  files: Schema.Array(Schema.String),
})
export type DiscardInput = Schema.Schema.Type<typeof DiscardInput>

export class GitOperationError extends Schema.TaggedErrorClass<GitOperationError>()("VcsGitOperationError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
  readonly remotes: () => Effect.Effect<Remote[]>
  readonly addRemote: (input: AddRemoteInput) => Effect.Effect<Remote, GitOperationError>
  readonly setRemote: (input: SetRemoteInput) => Effect.Effect<Remote, GitOperationError>
  readonly removeRemote: (input: RemoveRemoteInput) => Effect.Effect<void, GitOperationError>
  readonly branches: () => Effect.Effect<Branch[]>
  readonly log: (input: LogInput) => Effect.Effect<Commit[]>
  readonly createBranch: (input: CreateBranchInput) => Effect.Effect<Branch, GitOperationError>
  readonly deleteBranch: (input: DeleteBranchInput) => Effect.Effect<void, GitOperationError>
  readonly checkout: (input: CheckoutInput) => Effect.Effect<void, GitOperationError>
  readonly commit: (input: CommitInput) => Effect.Effect<Commit, GitOperationError>
  readonly push: (input: PushInput) => Effect.Effect<void, GitOperationError>
  readonly pull: (input: PullInput) => Effect.Effect<void, GitOperationError>
  readonly discard: (input: DiscardInput) => Effect.Effect<void, GitOperationError>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    function requireGit(operation: string) {
      return Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new GitOperationError({ operation, message: "The project is not git-based" })
        return ctx
      })
    }

    const gitFailure = (operation: string, result: { stderr: Buffer; text(): string }) =>
      new GitOperationError({
        operation,
        message: result.stderr.toString("utf8").trim() || result.text().trim() || `git ${operation} failed`,
      })

    const syncBranch = Effect.fnUntraced(function* () {
      const value = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      const next = ctx.project.vcs === "git" ? yield* git.branch(ctx.directory) : undefined
      if (next !== value.current) {
        value.current = next
        yield* events.publish(Event.BranchUpdated, { branch: next })
      }
      yield* events.publish(Event.Changed, { branch: next })
    })

    const publishChanged = Effect.fnUntraced(function* () {
      const value = yield* InstanceState.get(state)
      yield* events.publish(Event.Changed, { branch: value.current })
    })

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??"),
          (item) => git.patchUntracked(ctx.directory, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the project is not git-based",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
      remotes: Effect.fn("Vcs.remotes")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        return yield* git.remotes(ctx.directory)
      }),
      addRemote: Effect.fn("Vcs.addRemote")(function* (input: AddRemoteInput) {
        const ctx = yield* requireGit("add-remote")
        const result = yield* git.addRemote(ctx.directory, input.name, input.url)
        if (result.exitCode !== 0) return yield* gitFailure("add-remote", result)
        yield* publishChanged()
        return { name: input.name, url: input.url } satisfies Remote
      }),
      setRemote: Effect.fn("Vcs.setRemote")(function* (input: SetRemoteInput) {
        const ctx = yield* requireGit("set-remote")
        const result = yield* git.setRemoteUrl(ctx.directory, input.name, input.url)
        if (result.exitCode !== 0) return yield* gitFailure("set-remote", result)
        yield* publishChanged()
        return { name: input.name, url: input.url } satisfies Remote
      }),
      removeRemote: Effect.fn("Vcs.removeRemote")(function* (input: RemoveRemoteInput) {
        const ctx = yield* requireGit("remove-remote")
        const result = yield* git.removeRemote(ctx.directory, input.name)
        if (result.exitCode !== 0) return yield* gitFailure("remove-remote", result)
        yield* publishChanged()
      }),
      branches: Effect.fn("Vcs.branches")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        return yield* git.branches(ctx.directory)
      }),
      log: Effect.fn("Vcs.log")(function* (input: LogInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        return yield* git.log(ctx.directory, { limit: input.limit })
      }),
      createBranch: Effect.fn("Vcs.createBranch")(function* (input: CreateBranchInput) {
        const ctx = yield* requireGit("create-branch")
        const result = yield* git.createBranch(ctx.directory, input.name, input.from)
        if (result.exitCode !== 0) return yield* gitFailure("create-branch", result)
        yield* syncBranch()
        const created = yield* git.branches(ctx.directory)
        return (
          created.find((branch) => branch.name === input.name) ?? {
            name: input.name,
            current: true,
            remote: false,
            ahead: 0,
            behind: 0,
          }
        )
      }),
      deleteBranch: Effect.fn("Vcs.deleteBranch")(function* (input: DeleteBranchInput) {
        const ctx = yield* requireGit("delete-branch")
        const result = yield* git.deleteBranch(ctx.directory, input.name, input.force)
        if (result.exitCode !== 0) return yield* gitFailure("delete-branch", result)
        yield* syncBranch()
      }),
      checkout: Effect.fn("Vcs.checkout")(function* (input: CheckoutInput) {
        const ctx = yield* requireGit("checkout")
        const result = yield* git.checkout(ctx.directory, input.name)
        if (result.exitCode !== 0) return yield* gitFailure("checkout", result)
        yield* syncBranch()
      }),
      commit: Effect.fn("Vcs.commit")(function* (input: CommitInput) {
        const ctx = yield* requireGit("commit")
        const result = yield* git.commit(ctx.directory, { message: input.message, amend: input.amend, all: true })
        if (result.exitCode !== 0) return yield* gitFailure("commit", result)
        const [head] = yield* git.log(ctx.directory, { limit: 1 })
        if (!head) return yield* gitFailure("commit", result)
        yield* syncBranch()
        return head
      }),
      push: Effect.fn("Vcs.push")(function* (input: PushInput) {
        const ctx = yield* requireGit("push")
        const remotes = yield* git.remotes(ctx.directory)
        const remote = input.remote ?? "origin"
        if (!remotes.some((item) => item.name === remote))
          return yield* new GitOperationError({ operation: "push", message: `No remote named ${remote}` })
        const result = yield* git.push(ctx.directory, { remote, setUpstream: input.setUpstream, force: input.force })
        if (result.exitCode !== 0) return yield* gitFailure("push", result)
        yield* syncBranch()
      }),
      pull: Effect.fn("Vcs.pull")(function* (input: PullInput) {
        const ctx = yield* requireGit("pull")
        const result = yield* git.pull(ctx.directory, { rebase: input.rebase })
        if (result.exitCode !== 0) return yield* gitFailure("pull", result)
        yield* syncBranch()
      }),
      discard: Effect.fn("Vcs.discard")(function* (input: DiscardInput) {
        const ctx = yield* requireGit("discard")
        const list = yield* git.status(ctx.directory)
        const codes = new Map(list.map((item) => [item.file, item.code]))
        const untrackedFiles = input.files.filter((file) => codes.get(file) === "??")
        const trackedFiles = input.files.filter((file) => codes.get(file) !== "??")
        const [tracked, untracked] = yield* Effect.all(
          [git.restore(ctx.directory, trackedFiles), git.untracked(ctx.directory, untrackedFiles)],
          { concurrency: 2 },
        )
        const failed = [tracked, untracked].find((item) => item.exitCode !== 0)
        if (failed) return yield* gitFailure("discard", failed)
        yield* syncBranch()
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Git.node, EventV2Bridge.node] })

export * as Vcs from "./vcs"
