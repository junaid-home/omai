import { Effect } from "effect"
import path from "node:path"
import { array, check, object } from "./assertions"
import { http, route } from "./dsl"

export const checkpointScenarios = [
  http.protected
    .get("/project/{projectID}/checkpoint", "omai.checkpoint.list")
    .seeded((ctx) => ctx.checkpoint())
    .at((ctx) => ({
      path: route("/project/{projectID}/checkpoint", { projectID: ctx.state.projectID }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(body.length === 1, "project must list its persisted checkpoint")
      object(body[0])
      check(body[0].id === ctx.state.id && body[0].title === "HTTP checkpoint", "checkpoint metadata must round-trip")
    }),
  http.protected
    .get("/project/{projectID}/checkpoint/{checkpointID}/diff", "omai.checkpoint.diff")
    .seeded((ctx) => ctx.checkpoint())
    .at((ctx) => ({
      path: route("/project/{projectID}/checkpoint/{checkpointID}/diff", {
        projectID: ctx.state.projectID,
        checkpointID: ctx.state.id,
      }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      array(body.files)
      check(body.checkpoint === ctx.state.id, "diff must identify the selected checkpoint")
      check(
        body.files.some((file) => {
          object(file)
          return file.file === "checkpoint.txt"
        }),
        "diff must contain the captured file change",
      )
    }),
  http.protected
    .post("/project/{projectID}/checkpoint/{checkpointID}/rollback", "omai.checkpoint.rollback")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const saved = yield* ctx.checkpoint()
        yield* ctx.file("checkpoint.txt", "later content\n")
        return saved
      }),
    )
    .at((ctx) => ({
      path: route("/project/{projectID}/checkpoint/{checkpointID}/rollback", {
        projectID: ctx.state.projectID,
        checkpointID: ctx.state.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.id === ctx.state.id, "rollback must identify the restored checkpoint")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "checkpoint.txt")).text())) ===
            "captured content\n",
          "rollback must actually restore captured file bytes",
        )
      }),
    ),
]
