import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
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
    const session = yield* Session.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const summary = Effect.fn("ProjectHttpApi.summary")(function* () {
      const [projects, sessions] = yield* Effect.all([svc.list(), session.listLatestPerDirectory()], {
        concurrency: 2,
      })
      return { projects, sessions }
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
      const target = yield* svc.get(ctx.params.projectID).pipe(
        Effect.flatMap((found) =>
          found
            ? Effect.succeed(found)
            : Effect.fail(
                new ProjectNotFoundError({
                  projectID: ctx.params.projectID,
                  message: `Project not found: ${ctx.params.projectID}`,
                }),
              ),
        ),
      )

      const directories = yield* project.directories({ projectID: ctx.params.projectID })
      const projectDirs = new Set<string>([target.worktree, ...directories.map((item) => item.directory)])
      yield* Effect.forEach(
        [...projectDirs].filter((directory) => directory !== instance.directory),
        (directory) => store.disposeDirectory(directory),
        { discard: true },
      )
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

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("summary", summary)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("remove", remove)
      .handle("directories", directories)
  }),
)
