import { Checkpoint } from "@/checkpoint"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CheckpointNotFoundError, SessionBusyError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project/:projectID/checkpoint"

export const CheckpointApi = HttpApi.make("checkpoint")
  .add(
    HttpApiGroup.make("checkpoint")
      .add(
        HttpApiEndpoint.get("list", root, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Checkpoint.Summary), "List of project checkpoints"),
          error: [HttpApiError.InternalServerError, CheckpointNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "checkpoint.list",
            summary: "List project checkpoints",
            description: "Get the checkpoint history for the active project worktree.",
          }),
        ),
        HttpApiEndpoint.get("diff", `${root}/:checkpointID/diff`, {
          params: { projectID: ProjectV2.ID, checkpointID: Checkpoint.ID },
          query: WorkspaceRoutingQuery,
          success: described(Checkpoint.Diff, "Checkpoint file changes"),
          error: [HttpApiError.InternalServerError, CheckpointNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "checkpoint.diff",
            summary: "Get checkpoint changes",
            description: "Get the file changes recorded for a project checkpoint.",
          }),
        ),
        HttpApiEndpoint.post("rollback", `${root}/:checkpointID/rollback`, {
          params: { projectID: ProjectV2.ID, checkpointID: Checkpoint.ID },
          query: WorkspaceRoutingQuery,
          success: described(Checkpoint.Summary, "Restored project checkpoint"),
          error: [HttpApiError.InternalServerError, CheckpointNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "checkpoint.rollback",
            summary: "Roll back to a project checkpoint",
            description: "Restore project files, development databases, and Agent memory to a checkpoint.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "checkpoint",
          description: "Project checkpoint history and rollback routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OMAI+ experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
