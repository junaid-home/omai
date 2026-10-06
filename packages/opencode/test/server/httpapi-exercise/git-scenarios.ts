import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { array, check, object } from "./assertions"
import { http } from "./dsl"

function git(directory: string, ...args: string[]) {
  return Effect.promise(async () => {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`fixture git ${args[0]} failed: ${stderr}`)
    return stdout.trim()
  })
}

function remote(directory: string) {
  return Effect.gen(function* () {
    const target = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "httpapi-remote-"))),
      (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
    )
    yield* git(target, "init", "--bare")
    yield* git(directory, "remote", "add", "origin", target)
    return target
  })
}

export const gitScenarios = [
  http.protected
    .get("/git", "git.summary")
    .seeded((ctx) => ctx.file("pending.txt", "untracked"))
    .json(200, (body) => {
      object(body)
      check(
        body.initialized === true && typeof body.branch === "string",
        "git summary should identify the real repository",
      )
      check(
        body.changed_files === 1 && body.ahead === 0 && body.behind === 0,
        "summary should count the untracked file",
      )
      array(body.remotes)
      check(body.remotes.length === 0, "new repository should have no remotes")
    }),
  http.protected
    .get("/git/branches", "git.branches")
    .seeded((ctx) => git(ctx.directory!, "branch", "fixture-branch"))
    .json(200, (body) => {
      array(body)
      check(
        body.some((item) => {
          object(item)
          return item.name === "fixture-branch" && item.current === false
        }),
        "created branch should be listed",
      )
      check(
        body.filter((item) => {
          object(item)
          return item.current === true
        }).length === 1,
        "exactly one current branch expected",
      )
    }),
  http.protected
    .get("/git/log", "git.log")
    .at((ctx) => ({ path: "/git/log?limit=1", headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        array(body)
        check(body.length === 1, "log should honor limit")
        object(body[0])
        check(body[0].hash === (yield* git(ctx.directory!, "rev-parse", "HEAD")), "log must return the actual HEAD")
      }),
    ),
  http.protected
    .post("/git/branch", "git.branch.create")
    .at((ctx) => ({ path: "/git/branch", headers: ctx.headers(), body: { name: "new-branch" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.name === "new-branch" && body.current === true, "created branch should be selected")
        check(
          (yield* git(ctx.directory!, "branch", "--show-current")) === "new-branch",
          "branch create must update Git HEAD",
        )
      }),
    ),
  http.protected
    .post("/git/branch/delete", "git.branch.delete")
    .seeded((ctx) => git(ctx.directory!, "branch", "delete-me"))
    .at((ctx) => ({ path: "/git/branch/delete", headers: ctx.headers(), body: { name: "delete-me" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "delete should succeed")
        check((yield* git(ctx.directory!, "branch", "--list", "delete-me")) === "", "deleted branch must disappear")
      }),
    ),
  http.protected
    .post("/git/checkout", "git.checkout")
    .seeded((ctx) => git(ctx.directory!, "branch", "switch-to"))
    .at((ctx) => ({ path: "/git/checkout", headers: ctx.headers(), body: { name: "switch-to" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "checkout should succeed")
        check((yield* git(ctx.directory!, "branch", "--show-current")) === "switch-to", "checkout must update Git HEAD")
      }),
    ),
  http.protected
    .post("/git/commit", "git.commit")
    .seeded((ctx) => ctx.file("committed.txt", "stored through HTTP\n"))
    .at((ctx) => ({ path: "/git/commit", headers: ctx.headers(), body: { message: "HTTP fixture commit" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.subject === "HTTP fixture commit", "commit response should carry submitted subject")
        check(body.hash === (yield* git(ctx.directory!, "rev-parse", "HEAD")), "commit must persist as HEAD")
        check(
          (yield* git(ctx.directory!, "show", "HEAD:committed.txt")) === "stored through HTTP",
          "commit must contain staged bytes",
        )
      }),
    ),
  http.protected
    .post("/git/remote", "git.remote.add")
    .at((ctx) => ({
      path: "/git/remote",
      headers: ctx.headers(),
      body: { name: "fixture", url: "/tmp/httpapi-unused-remote" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(
          body.name === "fixture" && body.url === "/tmp/httpapi-unused-remote",
          "remote response should match request",
        )
        check((yield* git(ctx.directory!, "remote", "get-url", "fixture")) === body.url, "remote URL must persist")
      }),
    ),
  http.protected
    .post("/git/remote/set", "git.remote.set")
    .seeded((ctx) => git(ctx.directory!, "remote", "add", "fixture", "/tmp/old-unused-remote"))
    .at((ctx) => ({
      path: "/git/remote/set",
      headers: ctx.headers(),
      body: { name: "fixture", url: "/tmp/new-unused-remote" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.url === "/tmp/new-unused-remote", "updated URL should be returned")
        check((yield* git(ctx.directory!, "remote", "get-url", "fixture")) === body.url, "updated URL must persist")
      }),
    ),
  http.protected
    .post("/git/remote/delete", "git.remote.delete")
    .seeded((ctx) => git(ctx.directory!, "remote", "add", "fixture", "/tmp/unused-remote"))
    .at((ctx) => ({ path: "/git/remote/delete", headers: ctx.headers(), body: { name: "fixture" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "remote deletion should succeed")
        check((yield* git(ctx.directory!, "remote")) === "", "remote must disappear from Git config")
      }),
    ),
  http.protected
    .post("/git/push", "git.push.localRemote")
    .seeded((ctx) => remote(ctx.directory!))
    .at((ctx) => ({ path: "/git/push", headers: ctx.headers(), body: { remote: "origin", setUpstream: true } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(typeof body.output === "string", "push output should be serialized")
        const branch = yield* git(ctx.directory!, "branch", "--show-current")
        check(
          (yield* git(ctx.state, "rev-parse", `refs/heads/${branch}`)) ===
            (yield* git(ctx.directory!, "rev-parse", "HEAD")),
          "push must copy the commit to the isolated bare remote",
        )
      }),
    ),
  http.protected
    .post("/git/pull", "git.pull.localRemote")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const target = yield* remote(ctx.directory!)
        yield* git(ctx.directory!, "push", "--set-upstream", "origin", "HEAD")
        const prior = yield* git(ctx.directory!, "rev-parse", "HEAD")
        yield* ctx.file("remote-change.txt", "incoming\n")
        yield* git(ctx.directory!, "add", "remote-change.txt")
        yield* git(ctx.directory!, "commit", "-m", "incoming remote change")
        const incoming = yield* git(ctx.directory!, "rev-parse", "HEAD")
        yield* git(ctx.directory!, "push", "origin", "HEAD")
        yield* git(ctx.directory!, "reset", "--hard", prior)
        return { target, incoming }
      }),
    )
    .at((ctx) => ({ path: "/git/pull", headers: ctx.headers(), body: { rebase: false } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(typeof body.output === "string", "pull output should be serialized")
        check(
          (yield* git(ctx.directory!, "rev-parse", "HEAD")) === ctx.state.incoming,
          "pull must advance to remote commit",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "remote-change.txt")).text())) ===
            "incoming\n",
          "pull must restore incoming working-tree content",
        )
      }),
    ),
  http.protected
    .post("/git/discard", "git.discard")
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* ctx.file("tracked.txt", "original\n")
        yield* git(ctx.directory!, "add", "tracked.txt")
        yield* git(ctx.directory!, "commit", "-m", "tracked fixture")
        yield* ctx.file("tracked.txt", "changed\n")
        yield* ctx.file("untracked.txt", "remove me")
      }),
    )
    .at((ctx) => ({ path: "/git/discard", headers: ctx.headers(), body: { files: ["tracked.txt", "untracked.txt"] } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "discard should succeed")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "tracked.txt")).text())) === "original\n",
          "discard must restore tracked content",
        )
        check(
          !(yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "untracked.txt")).exists())),
          "discard must remove the selected untracked file",
        )
      }),
    ),
]
