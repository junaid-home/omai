import { Vcs } from "@/project/vcs"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"
import type { GitSummary } from "../groups/git"

const invalid = (error: Vcs.GitOperationError) =>
  new InvalidRequestError({ message: error.message, kind: "git", field: error.operation })

export const gitHandlers = HttpApiBuilder.group(InstanceHttpApi, "git", (handlers) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.Service

    const info = Effect.fn("GitHttpApi.info")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return {
          initialized: false,
          ahead: 0,
          behind: 0,
          remotes: [],
          changed_files: 0,
        } satisfies GitSummary
      }
      const [branches, remotes, changed] = yield* Effect.all([vcs.branches(), vcs.remotes(), vcs.status()], {
        concurrency: 3,
      })
      const current = branches.find((branch) => branch.current)
      return {
        initialized: true,
        branch: current?.name,
        default_branch: yield* vcs.defaultBranch(),
        upstream: current?.upstream,
        ahead: current?.ahead ?? 0,
        behind: current?.behind ?? 0,
        remotes,
        changed_files: changed.length,
      } satisfies GitSummary
    })

    return handlers
      .handle("info", info)
      .handle("branches", () => vcs.branches())
      .handle("log", (ctx) => vcs.log({ limit: ctx.query.limit }))
      .handle("createBranch", (ctx) =>
        vcs
          .createBranch(ctx.payload)
          .pipe(Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error)))),
      )
      .handle("deleteBranch", (ctx) =>
        vcs.deleteBranch(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ success: true }),
        ),
      )
      .handle("checkout", (ctx) =>
        vcs.checkout(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ success: true }),
        ),
      )
      .handle("commit", (ctx) =>
        vcs.commit(ctx.payload).pipe(Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error)))),
      )
      .handle("addRemote", (ctx) =>
        vcs
          .addRemote(ctx.payload)
          .pipe(Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error)))),
      )
      .handle("setRemote", (ctx) =>
        vcs
          .setRemote(ctx.payload)
          .pipe(Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error)))),
      )
      .handle("deleteRemote", (ctx) =>
        vcs.removeRemote(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ success: true }),
        ),
      )
      .handle("push", (ctx) =>
        vcs.push(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ output: "" }),
        ),
      )
      .handle("pull", (ctx) =>
        vcs.pull(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ output: "" }),
        ),
      )
      .handle("discard", (ctx) =>
        vcs.discard(ctx.payload).pipe(
          Effect.catchTag("VcsGitOperationError", (error) => Effect.fail(invalid(error))),
          Effect.as({ success: true }),
        ),
      )
  }),
)
