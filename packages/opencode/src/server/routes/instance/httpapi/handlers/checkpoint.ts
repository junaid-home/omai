import { Checkpoint } from "@/checkpoint"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CheckpointNotFoundError, SessionBusyError } from "../errors"
import type { Session } from "@/session/session"

function handleError(
  error: Checkpoint.NotFoundError | Storage.Error,
): Effect.Effect<never, CheckpointNotFoundError | HttpApiError.InternalServerError> {
  if (error._tag === "Checkpoint.NotFoundError") {
    return Effect.fail(
      new CheckpointNotFoundError({
        checkpointID: error.checkpointID ?? error.projectID,
        message: error.message,
      }),
    )
  }
  return Effect.fail(new HttpApiError.InternalServerError({}))
}

function handleRollbackError(
  error: Checkpoint.NotFoundError | Storage.Error | Session.BusyError,
): Effect.Effect<never, CheckpointNotFoundError | SessionBusyError | HttpApiError.InternalServerError> {
  if (error._tag === "SessionBusyError") {
    return Effect.fail(
      new SessionBusyError({
        sessionID: error.sessionID,
        message: `Session is busy: ${error.sessionID}`,
      }),
    )
  }
  return handleError(error)
}

export const checkpointHandlers = HttpApiBuilder.group(InstanceHttpApi, "checkpoint", (handlers) =>
  Effect.gen(function* () {
    const checkpoint = yield* Checkpoint.Service

    const list = Effect.fn("CheckpointHttpApi.list")(function* (ctx: { params: { projectID: ProjectV2.ID } }) {
      const values = yield* checkpoint.list(ctx.params.projectID).pipe(Effect.catch(handleError))
      return values.map(Checkpoint.summarize)
    })

    const diff = Effect.fn("CheckpointHttpApi.diff")(function* (ctx: {
      params: { projectID: ProjectV2.ID; checkpointID: Checkpoint.ID }
    }) {
      return yield* checkpoint
        .diff({ projectID: ctx.params.projectID, checkpointID: ctx.params.checkpointID })
        .pipe(Effect.catch(handleError))
    })

    const rollback = Effect.fn("CheckpointHttpApi.rollback")(function* (ctx: {
      params: { projectID: ProjectV2.ID; checkpointID: Checkpoint.ID }
    }) {
      const value = yield* checkpoint
        .rollback({ projectID: ctx.params.projectID, checkpointID: ctx.params.checkpointID })
        .pipe(Effect.catch(handleRollbackError))
      return Checkpoint.summarize(value)
    })

    return handlers.handle("list", list).handle("diff", diff).handle("rollback", rollback)
  }),
)
