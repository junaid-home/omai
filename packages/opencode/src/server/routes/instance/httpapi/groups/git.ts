import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { Vcs } from "@/project/vcs"
import { described } from "./metadata"

export const GitSummary = Schema.Struct({
  initialized: Schema.Boolean,
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  upstream: Schema.optional(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  remotes: Schema.Array(Vcs.Remote),
  changed_files: Schema.Number,
})
export type GitSummary = Schema.Schema.Type<typeof GitSummary>

export const GitLogQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})

export const GitPaths = {
  info: "/git",
  branches: "/git/branches",
  branch: "/git/branch",
  deleteBranch: "/git/branch/delete",
  checkout: "/git/checkout",
  log: "/git/log",
  commit: "/git/commit",
  remote: "/git/remote",
  setRemote: "/git/remote/set",
  deleteRemote: "/git/remote/delete",
  push: "/git/push",
  pull: "/git/pull",
  discard: "/git/discard",
} as const

export const GitApi = HttpApi.make("git")
  .add(
    HttpApiGroup.make("git")
      .add(
        HttpApiEndpoint.get("info", GitPaths.info, {
          query: WorkspaceRoutingQuery,
          success: described(GitSummary, "Git summary"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.info",
            summary: "Get git summary",
            description:
              "Retrieve the current branch, its upstream ahead/behind counts, configured remotes and the number of changed files.",
          }),
        ),
        HttpApiEndpoint.get("branches", GitPaths.branches, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.Branch), "Branches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.branches",
            summary: "List branches",
            description: "List local branches with upstream tracking and ahead/behind counts.",
          }),
        ),
        HttpApiEndpoint.get("log", GitPaths.log, {
          query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, ...GitLogQuery.fields }),
          success: described(Schema.Array(Vcs.Commit), "Commit history"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.log",
            summary: "Get commit history",
            description: "List commits reachable from the given ref, newest first.",
          }),
        ),
        HttpApiEndpoint.post("createBranch", GitPaths.branch, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.CreateBranchInput,
          success: described(Vcs.Branch, "Branch created"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.createBranch",
            summary: "Create branch",
            description: "Create a branch from the given starting point and check it out.",
          }),
        ),
        HttpApiEndpoint.post("deleteBranch", GitPaths.deleteBranch, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.DeleteBranchInput,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.deleteBranch",
            summary: "Delete branch",
            description: "Delete a local branch.",
          }),
        ),
        HttpApiEndpoint.post("checkout", GitPaths.checkout, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.CheckoutInput,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.checkout",
            summary: "Checkout branch",
            description: "Switch the working tree to an existing local branch.",
          }),
        ),
        HttpApiEndpoint.post("commit", GitPaths.commit, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.CommitInput,
          success: described(Vcs.Commit, "Commit created"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.commit",
            summary: "Create commit",
            description:
              "Stage every working tree change and create a commit. Amend replaces the most recent commit instead.",
          }),
        ),
        HttpApiEndpoint.post("addRemote", GitPaths.remote, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.AddRemoteInput,
          success: described(Vcs.Remote, "Remote added"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.addRemote",
            summary: "Add remote",
            description: "Register a new remote. The name must not already be configured.",
          }),
        ),
        HttpApiEndpoint.post("setRemote", GitPaths.setRemote, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.SetRemoteInput,
          success: described(Vcs.Remote, "Remote updated"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.setRemote",
            summary: "Update remote",
            description: "Replace the URL of an existing remote.",
          }),
        ),
        HttpApiEndpoint.post("deleteRemote", GitPaths.deleteRemote, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.RemoveRemoteInput,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.deleteRemote",
            summary: "Remove remote",
            description: "Remove a configured remote and its remote-tracking references.",
          }),
        ),
        HttpApiEndpoint.post("push", GitPaths.push, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.PushInput,
          success: described(Schema.Struct({ output: Schema.String }), "Push result"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.push",
            summary: "Push commits",
            description: "Push the current branch to a remote, optionally setting it as the upstream for the branch.",
          }),
        ),
        HttpApiEndpoint.post("pull", GitPaths.pull, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.PullInput,
          success: described(Schema.Struct({ output: Schema.String }), "Pull result"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.pull",
            summary: "Pull commits",
            description: "Fetch and integrate commits from the tracked remote, rebasing local commits by default.",
          }),
        ),
        HttpApiEndpoint.post("discard", GitPaths.discard, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.DiscardInput,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "git.discard",
            summary: "Discard changes",
            description:
              "Discard changes for the given files, restoring tracked files to HEAD and deleting untracked ones. An empty list discards every change.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "git",
          description: "Git routes for inspecting and managing the current project's repository.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OMAI+ git HttpApi",
      version: "0.0.1",
      description: "Git HttpApi surface for the current project's repository.",
    }),
  )
