import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const InitGitQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  force: Schema.optional(Schema.Literals(["true", "false"])),
})
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})

const ProjectOverview = Schema.Struct({
  projects: Schema.Array(Project.Info),
  sessions: Schema.Array(Session.GlobalInfo),
}).annotate({ identifier: "ProjectOverview" })

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "List of projects"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OMAI+.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Current project information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OMAI+ is working with.",
          }),
        ),
        HttpApiEndpoint.get("summary", `${root}/summary`, {
          query: WorkspaceRoutingQuery,
          success: described(ProjectOverview, "Projects with their latest sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.summary",
            summary: "Get projects summary",
            description:
              "Retrieve every project together with the newest active session for each working directory in a single response.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: InitGitQuery,
          success: described(Project.Info, "Project information after git initialization"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Updated project information"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "True once the project has been deleted"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.delete",
            summary: "Delete project",
            description: "Delete a project, remove its sessions, and wipe its worktree directory from disk.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
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
