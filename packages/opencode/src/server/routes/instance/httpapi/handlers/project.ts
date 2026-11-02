import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceOwner } from "@/control-plane/workspace-owner"
import { Authentication } from "@opencode-ai/core/authentication"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ProjectNotFoundError } from "../errors"
import { markInstanceForDisposal, markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service
    const store = yield* InstanceStore.Service
    const workspaceSvc = yield* Workspace.Service

    // Every user's projects share one database. A signed-in user reaches only
    // the projects whose VM they own; a VM, which the control plane proxies
    // to without a user, only the project it serves.
    const reachable = Effect.fn("ProjectHttpApi.reachable")(function* (target: Project.Info) {
      if (Flag.OPENCODE_WORKSPACE_ID) return target.id === (yield* InstanceState.context).project.id
      const principal = yield* Authentication.Current
      if (!principal) return true
      const workspace = yield* workspaceSvc.getByDirectory(target.worktree)
      return workspace !== undefined && WorkspaceOwner.permits(principal.userID, workspace)
    })

    // Another user's project is answered exactly like a missing one.
    const requireReachable = Effect.fn("ProjectHttpApi.requireReachable")(function* (projectID: ProjectV2.ID) {
      const found = yield* svc.get(projectID)
      if (found && (yield* reachable(found))) return found
      return yield* new ProjectNotFoundError({ projectID, message: `Project not found: ${projectID}` })
    })

    // The same rule as reachable, with every VM read in one query: a lookup per
    // project costs a database round trip each, which held the project list
    // for seconds.
    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      const projects = yield* svc.list()
      if (Flag.OPENCODE_WORKSPACE_ID) {
        const own = (yield* InstanceState.context).project.id
        return projects.filter((item) => item.id === own)
      }
      const principal = yield* Authentication.Current
      if (!principal) return projects
      const owned = new Set(
        (yield* workspaceSvc.all())
          .filter((workspace) => WorkspaceOwner.permits(principal.userID, workspace))
          .flatMap((workspace) => (workspace.directory ? [workspace.directory] : [])),
      )
      return projects.filter((item) => owned.has(item.worktree))
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* (ctx: { query: { force?: "true" | "false" } }) {
      const instance = yield* InstanceState.context
      const next = yield* svc.initGit({
        directory: instance.directory,
        project: instance.project,
        force: ctx.query.force === "true",
      })
      if (
        next.id === instance.project.id &&
        next.vcs === instance.project.vcs &&
        next.worktree === instance.project.worktree
      )
        return next
      yield* markInstanceForReload(instance, {
        directory: instance.directory,
        worktree: instance.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      yield* requireReachable(ctx.params.projectID)
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const remove = Effect.fn("ProjectHttpApi.remove")(function* (ctx: { params: { projectID: ProjectV2.ID } }) {
      const instance = yield* InstanceState.context
      const target = yield* requireReachable(ctx.params.projectID)

      const directories = yield* project.directories({ projectID: ctx.params.projectID })
      const projectDirs = new Set<string>([target.worktree, ...directories.map((item) => item.directory)])
      yield* Effect.forEach(
        [...projectDirs].filter((directory) => directory !== instance.directory),
        (directory) => store.disposeDirectory(directory),
        { discard: true },
      )
      // Tear down any VM-backed workspaces (and their services/volumes) for
      // this project so deleting the project also deletes the microVM.
      const workspaces = yield* workspaceSvc.list(target)
      yield* Effect.forEach(workspaces, (ws) => workspaceSvc.remove(ws.id).pipe(Effect.ignore), { discard: true })
      yield* svc.remove(ctx.params.projectID).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({ projectID: error.projectID, message: `Project not found: ${error.projectID}` }),
          ),
        ),
        Effect.catchTag("Project.InvalidTargetError", (error) =>
          Effect.fail(new InvalidRequestError({ message: error.message })),
        ),
      )
      if (instance.project.id === ctx.params.projectID) yield* markInstanceForDisposal(instance)
      return true
    })

    const directories = Effect.fn("ProjectHttpApi.directories")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
    }) {
      const found = yield* svc.get(ctx.params.projectID)
      if (!found || !(yield* reachable(found))) return []
      return yield* project.directories({ projectID: ctx.params.projectID })
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("remove", remove)
      .handle("directories", directories)
  }),
)
