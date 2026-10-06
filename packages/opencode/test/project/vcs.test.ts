import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
  it.instance(
    "commit() stages every change and returns the new commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "tracked.txt"), "one\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "tracked"])
        yield* write(path.join(test.directory, "tracked.txt"), "two\n")
        yield* write(path.join(test.directory, "fresh.txt"), "new\n")

        const vcs = yield* init()
        const commit = yield* vcs.commit({ message: "one box" })

        expect(commit.subject).toBe("one box")
        expect(commit.hash).toMatch(/^[0-9a-f]{40}$/)
        expect(yield* vcs.status()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "commit() surfaces a typed error when git rejects the operation",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const error = yield* vcs.commit({ message: "" }).pipe(Effect.flip)

        expect(error._tag).toBe("VcsGitOperationError")
        expect(error.operation).toBe("commit")
      }),
    { git: true },
  )

  it.instance("every write operation fails for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()

      const failures = yield* Effect.all(
        [
          vcs.commit({ message: "x" }),
          vcs.createBranch({ name: "x" }),
          vcs.deleteBranch({ name: "x" }),
          vcs.checkout({ name: "x" }),
          vcs.push({}),
          vcs.pull({}),
          vcs.discard({ files: [] }),
        ].map((effect) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          ),
        ),
        { concurrency: 7 },
      )

      expect(failures.every((message) => message === "The project is not git-based")).toBe(true)
    }),
  )

  it.instance(
    "createBranch() checks out the new branch and updates branch()",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const before = yield* vcs.branch()

        const created = yield* vcs.createBranch({ name: "feature/new" })

        expect(created.name).toBe("feature/new")
        expect(created.current).toBe(true)
        expect(yield* vcs.branch()).toBe("feature/new")
        expect(yield* vcs.branches().pipe(Effect.map((list) => list.map((item) => item.name)))).toContain(before!)
      }),
    { git: true },
  )

  it.instance(
    "createBranch() can branch from a specific starting point",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const base = yield* vcs.branch()

        yield* vcs.createBranch({ name: "feature/from-base", from: base })

        expect(yield* vcs.branch()).toBe("feature/from-base")
        const log = yield* vcs.log({ limit: 5 })
        expect(log).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "checkout() switches branches and rejects unknown ones",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "side"])

        const vcs = yield* init()
        yield* vcs.checkout({ name: "side" })
        expect(yield* vcs.branch()).toBe("side")

        const error = yield* vcs.checkout({ name: "missing" }).pipe(Effect.flip)
        expect(error._tag).toBe("VcsGitOperationError")
        expect(error.operation).toBe("checkout")
      }),
    { git: true },
  )

  it.instance(
    "deleteBranch() removes a branch and refuses to delete a missing one",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "gone"])

        const vcs = yield* init()
        yield* vcs.deleteBranch({ name: "gone" })

        const names = yield* vcs.branches().pipe(Effect.map((list) => list.map((item) => item.name)))
        expect(names).not.toContain("gone")
        expect(yield* vcs.deleteBranch({ name: "gone" }).pipe(Effect.flip)).toMatchObject({
          _tag: "VcsGitOperationError",
          operation: "delete-branch",
        })
      }),
    { git: true },
  )

  it.instance(
    "log() returns commits newest first and tolerates a limit",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        for (const message of ["one", "two", "three"]) {
          yield* write(path.join((yield* TestInstance).directory, `${message}.txt`), `${message}\n`)
          yield* vcs.commit({ message })
        }

        const all = yield* vcs.log({ limit: 10 })
        expect(all.map((commit) => commit.subject).slice(0, 3)).toEqual(["three", "two", "one"])

        const limited = yield* vcs.log({ limit: 1 })
        expect(limited.map((commit) => commit.subject)).toEqual(["three"])
        expect(all[0]?.author).toBe("Test")
      }),
    { git: true },
  )

  it.instance(
    "remotes() and branches() report repository configuration",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["remote", "add", "origin", "https://example.com/acme/app.git"])

        const vcs = yield* init()
        expect(yield* vcs.remotes()).toEqual([{ name: "origin", url: "https://example.com/acme/app.git" }])
        expect(yield* vcs.branches().pipe(Effect.map((list) => list.filter((item) => item.current)))).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "addRemote(), setRemote(), and removeRemote() maintain the configured remotes",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()

        expect(yield* vcs.addRemote({ name: "origin", url: "https://example.com/acme/app.git" })).toEqual({
          name: "origin",
          url: "https://example.com/acme/app.git",
        })
        expect(yield* vcs.remotes()).toEqual([{ name: "origin", url: "https://example.com/acme/app.git" }])

        expect(yield* vcs.setRemote({ name: "origin", url: "git@example.com:acme/app.git" })).toEqual({
          name: "origin",
          url: "git@example.com:acme/app.git",
        })
        expect(yield* vcs.remotes()).toEqual([{ name: "origin", url: "git@example.com:acme/app.git" }])

        yield* vcs.removeRemote({ name: "origin" })
        expect(yield* vcs.remotes()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "addRemote(), setRemote(), and removeRemote() report a typed error when git rejects the operation",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()

        expect(
          yield* vcs.setRemote({ name: "missing", url: "https://example.com/acme/app.git" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "VcsGitOperationError", operation: "set-remote" })
        expect(yield* vcs.removeRemote({ name: "missing" }).pipe(Effect.flip)).toMatchObject({
          _tag: "VcsGitOperationError",
          operation: "remove-remote",
        })
      }),
    { git: true },
  )

  it.instance(
    "remote mutations publish Changed so open panels refresh",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const events = yield* EventV2Bridge.Service
        const pending = yield* Deferred.make<string | undefined>()
        const off = yield* events.listen((event) => {
          if (event.type === Vcs.Event.Changed.type) Deferred.doneUnsafe(pending, Effect.succeed("changed"))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        yield* vcs.addRemote({ name: "origin", url: "https://example.com/acme/app.git" })

        expect(yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))).toBe("changed")
      }),
    { git: true },
  )

  it.instance(
    "push() rejects a remote that is not configured",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const error = yield* vcs.push({ remote: "missing" }).pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "VcsGitOperationError", operation: "push" })
        expect(error.message).toContain("missing")
      }),
    { git: true },
  )

  it.instance(
    "pull() fails without a remote",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        expect(yield* vcs.pull({}).pipe(Effect.flip)).toMatchObject({
          _tag: "VcsGitOperationError",
          operation: "pull",
        })
      }),
    { git: true },
  )

  it.instance(
    "discard() reverts tracked files and deletes untracked ones but spares ignored files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, ".gitignore"), ".env\n")
        yield* write(path.join(test.directory, "a.txt"), "one\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add a"])
        yield* write(path.join(test.directory, "a.txt"), "changed\n")
        yield* write(path.join(test.directory, "b.txt"), "untracked\n")
        yield* write(path.join(test.directory, ".env"), "SECRET=1\n")

        const vcs = yield* init()
        yield* vcs.discard({ files: [] })

        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "a.txt"), "utf-8"))).toBe("one\n")
        expect(yield* Effect.promise(() => fs.stat(path.join(test.directory, "b.txt")).catch(() => "gone"))).toBe(
          "gone",
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".env"), "utf-8"))).toBe("SECRET=1\n")
        expect(yield* vcs.status()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "discard() only touches the requested files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "one\n")
        yield* write(path.join(test.directory, "b.txt"), "one\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add a and b"])
        yield* write(path.join(test.directory, "a.txt"), "changed\n")
        yield* write(path.join(test.directory, "b.txt"), "changed\n")

        const vcs = yield* init()
        yield* vcs.discard({ files: ["a.txt"] })

        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "a.txt"), "utf-8"))).toBe("one\n")
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "b.txt"), "utf-8"))).toBe("changed\n")
        expect(yield* vcs.status().pipe(Effect.map((list) => list.map((item) => item.file)))).toEqual(["b.txt"])
      }),
    { git: true },
  )

  it.instance(
    "write operations publish a Changed event",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const changed = yield* Deferred.make<string | undefined>()
        const off = yield* events.listen((event) => {
          if (event.type === Vcs.Event.Changed.type)
            Deferred.doneUnsafe(changed, Effect.succeed((event.data as typeof Vcs.Event.Changed.data.Type).branch))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        const vcs = yield* init()
        yield* vcs.createBranch({ name: "feature/events" })

        const branch = yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"))
        expect(branch).toBe("feature/events")
      }),
    { git: true },
  )
})
