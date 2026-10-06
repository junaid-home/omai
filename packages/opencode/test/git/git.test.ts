import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"
const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Git", () => {
  it.live("branch() returns current branch name", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    }),
  )

  it.live("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("branch() returns undefined for detached HEAD", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const hash = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tmp.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git checkout --detach ${hash}`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("defaultBranch() uses init.defaultBranch when available", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M trunk`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.defaultBranch(tmp.path)
      expect(branch?.name).toBe("trunk")
      expect(branch?.ref).toBe("trunk")
    }),
  )

  it.live("status() handles special filenames", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8"))
      const git = yield* Git.Service
      const status = yield* git.status(tmp.path)
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "added",
          }),
        ]),
      )
    }),
  )

  it.live("diff(), stats(), and mergeBase() parse tracked changes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M main`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git checkout -b feature/test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))

      const git = yield* Git.Service
      const [base, diff, stats] = yield* Effect.all([
        git.mergeBase(tmp.path, "main"),
        git.diff(tmp.path, "HEAD"),
        git.stats(tmp.path, "HEAD"),
      ])

      expect(base).toBeTruthy()
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "modified",
          }),
        ]),
      )
      expect(stats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            additions: 1,
            deletions: 1,
          }),
        ]),
      )
    }),
  )

  it.live("patch() returns capped native patch output", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "old\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "new\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, all, capped] = yield* Effect.all([
        git.patch(tmp.path, "HEAD", weird, { context: 2_147_483_647 }),
        git.patchAll(tmp.path, "HEAD", { context: 2_147_483_647 }),
        git.patch(tmp.path, "HEAD", weird, { maxOutputBytes: 1 }),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("-before")
      expect(patch.text).toContain("+after")
      expect(all.truncated).toBe(false)
      expect(all.text).toContain("diff --git")
      expect(all.text).toContain("other.txt")
      expect(all.text).toContain("+new")
      expect(capped.truncated).toBe(true)
      expect(capped.text).toBe("")
    }),
  )

  it.live("patchUntracked() and statUntracked() handle added files", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "one\ntwo\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, stat] = yield* Effect.all([
        git.patchUntracked(tmp.path, weird, { context: 2_147_483_647 }),
        git.statUntracked(tmp.path, weird),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("+one")
      expect(patch.text).toContain("+two")
      expect(stat).toEqual(expect.objectContaining({ file: weird, additions: 2, deletions: 0 }))
    }),
  )

  it.live("show() returns empty text for binary blobs", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "bin.dat"), new Uint8Array([0, 1, 2, 3])))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add binary"`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const text = yield* git.show(tmp.path, "HEAD", "bin.dat")
      expect(text).toBe("")
    }),
  )
  it.live("branches() lists local branches and marks the current one", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch feature`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const list = yield* git.branches(tmp.path)
      const current = (yield* git.branch(tmp.path)) ?? ""

      expect(list.map((item) => item.name).toSorted()).toEqual(["feature", current].toSorted())
      expect(list.filter((item) => item.current).map((item) => item.name)).toEqual([current])
      expect(list.every((item) => item.remote === false)).toBe(true)
    }),
  )

  it.live("remotes() returns configured fetch urls", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git remote add origin https://example.com/acme/app.git`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git remote add fork git@example.com:acme/fork.git`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const list = yield* git.remotes(tmp.path)

      expect(list.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "fork", url: "git@example.com:acme/fork.git" },
        { name: "origin", url: "https://example.com/acme/app.git" },
      ])
    }),
  )

  it.live("addRemote(), setRemoteUrl(), and removeRemote() round-trip the configured urls", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })

      const git = yield* Git.Service
      expect((yield* git.addRemote(tmp.path, "origin", "https://example.com/acme/app.git")).exitCode).toBe(0)
      expect(yield* git.remotes(tmp.path)).toEqual([{ name: "origin", url: "https://example.com/acme/app.git" }])

      expect((yield* git.setRemoteUrl(tmp.path, "origin", "git@example.com:acme/app.git")).exitCode).toBe(0)
      expect(yield* git.remotes(tmp.path)).toEqual([{ name: "origin", url: "git@example.com:acme/app.git" }])

      expect((yield* git.removeRemote(tmp.path, "origin")).exitCode).toBe(0)
      expect(yield* git.remotes(tmp.path)).toEqual([])
    }),
  )

  it.live("addRemote() rejects a duplicate name and removeRemote() rejects an unknown one", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git remote add origin https://example.com/acme/app.git`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      expect((yield* git.addRemote(tmp.path, "origin", "https://example.com/acme/fork.git")).exitCode).not.toBe(0)
      expect((yield* git.setRemoteUrl(tmp.path, "missing", "https://example.com/acme/fork.git")).exitCode).not.toBe(0)
      expect((yield* git.removeRemote(tmp.path, "missing")).exitCode).not.toBe(0)
      expect(yield* git.remotes(tmp.path)).toEqual([{ name: "origin", url: "https://example.com/acme/app.git" }])
    }),
  )

  it.live("createBranch() creates and checks out the branch", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })

      const git = yield* Git.Service
      const result = yield* git.createBranch(tmp.path, "topic")
      expect(result.exitCode).toBe(0)
      expect(yield* git.branch(tmp.path)).toBe("topic")
    }),
  )

  it.live("createBranch() rejects invalid branch names", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })

      const git = yield* Git.Service
      const result = yield* git.createBranch(tmp.path, "--force")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString("utf8")).toContain("Invalid branch name")
    }),
  )

  it.live("deleteBranch() removes a merged branch and keeps the current one when unmerged", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch merged`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git branch unmerged`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      expect((yield* git.deleteBranch(tmp.path, "merged")).exitCode).toBe(0)
      expect((yield* git.branches(tmp.path)).map((item) => item.name)).not.toContain("merged")

      yield* Effect.promise(() => $`git checkout unmerged`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "only.txt"), "x\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m unmerged`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git checkout -`.cwd(tmp.path).quiet())

      expect((yield* git.deleteBranch(tmp.path, "unmerged")).exitCode).not.toBe(0)
      expect((yield* git.deleteBranch(tmp.path, "unmerged", true)).exitCode).toBe(0)
    }),
  )

  it.live("checkout() switches branches and reports the result", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch other`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      expect((yield* git.checkout(tmp.path, "other")).exitCode).toBe(0)
      expect(yield* git.branch(tmp.path)).toBe("other")
      expect((yield* git.checkout(tmp.path, "missing")).exitCode).not.toBe(0)
    }),
  )

  it.live("commit() stages every change including untracked files", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "tracked.txt"), "a\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m tracked`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "tracked.txt"), "b\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "fresh.txt"), "c\n", "utf-8"))

      const git = yield* Git.Service
      expect((yield* git.commit(tmp.path, { message: "one box", all: true })).exitCode).toBe(0)

      const [head] = yield* git.log(tmp.path, { limit: 1 })
      expect(head?.subject).toBe("one box")
      expect(head?.author).toBe("Test")
      expect(head?.email).toBe("test@opencode.test")
      expect(yield* git.status(tmp.path)).toEqual([])
    }),
  )

  it.live("commit() requires a message", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const result = yield* git.commit(tmp.path, { message: "   " })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString("utf8")).toContain("Commit message is required")
    }),
  )

  it.live("commit() surfaces a clear error when the git identity is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git config user.email ""`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config user.name ""`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const result = yield* git.commit(tmp.path, { message: "no identity" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString("utf8")).toContain("user.email")
    }),
  )

  it.live("commit() amends the previous commit", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.txt"), "a\n", "utf-8"))

      const git = yield* Git.Service
      yield* git.commit(tmp.path, { message: "first", all: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.txt"), "a\nb\n", "utf-8"))
      yield* git.commit(tmp.path, { message: "second", amend: true, all: true })

      const list = yield* git.log(tmp.path, { limit: 10 })
      expect(list.map((item) => item.subject)).not.toContain("first")
      expect(list[0]?.subject).toBe("second")
    }),
  )

  it.live("log() returns newest first and keeps multi-line bodies intact", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() =>
        $`git commit --allow-empty --no-gpg-sign -m ${"subject line"} -m ${"body one"} -m ${"body two"}`
          .cwd(tmp.path)
          .quiet(),
      )

      const git = yield* Git.Service
      const [head] = yield* git.log(tmp.path, { limit: 1 })

      expect(head?.subject).toBe("subject line")
      expect(head?.body).toBe("body one\n\nbody two")
      expect(head?.short).toBe(head?.hash.slice(0, head?.short.length))
      expect(head?.date).toBeGreaterThan(0)
      expect(head?.parents).toHaveLength(1)
    }),
  )

  it.live("log() honors the limit", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      for (const message of ["one", "two", "three"]) {
        yield* Effect.promise(() => $`git commit --allow-empty --no-gpg-sign -m ${message}`.cwd(tmp.path).quiet())
      }

      const git = yield* Git.Service
      const list = yield* git.log(tmp.path, { limit: 2 })
      expect(list.map((item) => item.subject)).toEqual(["three", "two"])
    }),
  )

  it.live("log() returns an empty history for an unborn branch", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      yield* Effect.promise(() => $`git init`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      expect(yield* git.log(tmp.path, {})).toEqual([])
    }),
  )

  it.live("branches() reports ahead and behind counts against the upstream", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const remote = yield* scopedTmpdir()
      yield* Effect.promise(() => $`git init --bare`.cwd(remote.path).quiet())
      yield* Effect.promise(() => $`git init`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git remote add origin ${remote.path}`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --allow-empty --no-gpg-sign -m root`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git push --set-upstream origin HEAD`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --allow-empty --no-gpg-sign -m local`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const [branch] = yield* git.branches(tmp.path)
      expect(branch?.upstream).toMatch(/^origin\/.+$/)
      expect(branch?.ahead).toBe(1)
      expect(branch?.behind).toBe(0)
    }),
  )

  it.live("push() and pull() move commits to and from a remote", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const remote = yield* scopedTmpdir()
      const clone = yield* scopedTmpdir()
      yield* Effect.promise(() => $`git init --bare`.cwd(remote.path).quiet())
      yield* Effect.promise(() => $`git init`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git remote add origin ${remote.path}`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --allow-empty --no-gpg-sign -m root`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      expect((yield* git.push(tmp.path, { setUpstream: true })).exitCode).toBe(0)
      expect((yield* git.push(tmp.path, { remote: "nope" })).exitCode).not.toBe(0)

      yield* Effect.promise(() => $`git clone ${remote.path} ${clone.path}`.quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(clone.path).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(clone.path).quiet())
      yield* Effect.promise(() => $`git commit --allow-empty --no-gpg-sign -m ${"remote only"}`.cwd(clone.path).quiet())
      yield* Effect.promise(() => $`git push origin HEAD`.cwd(clone.path).quiet())

      expect((yield* git.pull(tmp.path, {})).exitCode).toBe(0)
      const subjects = (yield* git.log(tmp.path, { limit: 5 })).map((item) => item.subject)
      expect(subjects).toContain("remote only")
    }),
  )

  it.live("restore() reverts tracked files and leaves untracked files alone", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.txt"), "one\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m add`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.txt"), "two\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "b.txt"), "new\n", "utf-8"))

      const git = yield* Git.Service
      expect((yield* git.restore(tmp.path, ["a.txt"])).exitCode).toBe(0)
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "a.txt"), "utf-8"))).toBe("one\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "b.txt"), "utf-8"))).toBe("new\n")
    }),
  )

  it.live("untracked() deletes untracked files without touching ignored ones", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), ".env\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "b.txt"), "new\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".env"), "SECRET=1\n", "utf-8"))

      const git = yield* Git.Service
      expect((yield* git.untracked(tmp.path, ["b.txt"])).exitCode).toBe(0)
      expect(yield* Effect.promise(() => fs.stat(path.join(tmp.path, "b.txt")).catch(() => "missing"))).toBe("missing")

      expect((yield* git.untracked(tmp.path, [])).exitCode).toBe(0)
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, ".env"), "utf-8"))).toBe("SECRET=1\n")
    }),
  )
})
