import { UserState } from "@opencode-ai/core/user-state"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"

export class UserStateConflict extends Schema.ErrorClass<UserStateConflict>("UserStateConflict")(
  UserState.Snapshot.fields,
  { httpApiStatus: 409 },
) {}

export const UserStateApi = HttpApi.make("user-state").add(
  HttpApiGroup.make("user-state")
    .add(
      HttpApiEndpoint.get("get", "/user-state", {
        query: UserState.Query,
        headers: { "x-opencode-user-id": Schema.optional(Schema.String) },
        success: UserState.Snapshot,
        error: [InvalidRequestError, HttpApiError.UnauthorizedNoContent],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "userState.get",
          summary: "Read the current user's persisted state",
          description:
            "Missing entries have revision zero. A null value with a positive revision is a deletion tombstone.",
        }),
      ),
      HttpApiEndpoint.put("put", "/user-state", {
        payload: UserState.Write,
        headers: { "x-opencode-user-id": Schema.optional(Schema.String) },
        success: UserState.Snapshot,
        error: [InvalidRequestError, HttpApiError.UnauthorizedNoContent, UserStateConflict],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "userState.put",
          summary: "Conditionally save the current user's state",
          description:
            "Writes succeed only at the expected revision. Conflicts return the current value and revision with HTTP 409.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "user-state", description: "Private, revisioned browser state." })),
)
