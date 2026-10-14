import { Role, SettingsPermissionsSchema } from "@opencode-ai/core/user/permissions"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError, InvalidRequestError } from "../errors"
import { described } from "./metadata"

const AssignedModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
})

export const AdminUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
  role: Role,
  settingsPermissions: SettingsPermissionsSchema,
  model: Schema.NullOr(AssignedModel),
})
export type AdminUser = Schema.Schema.Type<typeof AdminUser>

export const AdminCreateUserInput = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
  role: Schema.optional(Role),
  settingsPermissions: Schema.optional(SettingsPermissionsSchema),
  model: Schema.optional(Schema.NullOr(AssignedModel)),
})

export const AdminUpdateUserInput = Schema.Struct({
  role: Schema.optional(Role),
  settingsPermissions: Schema.optional(SettingsPermissionsSchema),
  password: Schema.optional(Schema.String),
  model: Schema.optional(Schema.NullOr(AssignedModel)),
})

const AdminUserParams = Schema.Struct({
  userID: Schema.String,
})

export const AdminPaths = {
  users: "/admin/users",
  user: "/admin/users/:userID",
} as const

export const AdminApi = HttpApi.make("admin").add(
  HttpApiGroup.make("admin")
    .add(
      HttpApiEndpoint.get("list", AdminPaths.users, {
        success: described(Schema.Array(AdminUser), "All users"),
        error: ForbiddenError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "admin.list",
          summary: "List users",
          description: "List every user on the instance with role and settings permissions.",
        }),
      ),
      HttpApiEndpoint.post("create", AdminPaths.users, {
        payload: AdminCreateUserInput,
        success: described(AdminUser, "User created"),
        error: [ForbiddenError, InvalidRequestError, ConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "admin.create",
          summary: "Create a user",
          description: "Create a new user with a role and settings permissions.",
        }),
      ),
      HttpApiEndpoint.patch("update", AdminPaths.user, {
        params: AdminUserParams,
        payload: AdminUpdateUserInput,
        success: described(AdminUser, "User updated"),
        error: [ForbiddenError, HttpApiError.NotFound, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "admin.update",
          summary: "Update a user",
          description: "Change a user's role, settings permissions, or password.",
        }),
      ),
      HttpApiEndpoint.delete("remove", AdminPaths.user, {
        params: AdminUserParams,
        success: described(Schema.Boolean, "User removed"),
        error: [ForbiddenError, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "admin.remove",
          summary: "Remove a user",
          description: "Delete a user account and revoke its sessions.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "admin", description: "Administrator user management." })),
)
