import { UserState } from "@opencode-ai/core/user-state"
import { Authentication } from "@opencode-ai/core/authentication"
import { Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { InvalidRequestError } from "../errors"
import { UserStateConflict } from "../groups/user-state"

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
)

// A second tab may have changed the cookie's account since this UI hydrated.
// The header is a precondition only; authority always comes from authentication.
export const requireUser = Effect.fn("UserStateHttpApi.requireUser")(function* (expectedUserID: string | undefined) {
  const principal = yield* Authentication.Current
  if (!principal || expectedUserID !== principal.userID) return yield* new HttpApiError.Unauthorized({})
})

export const userStateHandlers = HttpApiBuilder.group(RootHttpApi, "user-state", (handlers) =>
  Effect.gen(function* () {
    const state = yield* UserState.Service

    return handlers
      .handle("get", ({ query, headers }) =>
        noStore.pipe(
          Effect.andThen(requireUser(headers["x-opencode-user-id"])),
          Effect.andThen(state.get(query)),
          Effect.catchTag("UserState.Unauthenticated", () => Effect.fail(new HttpApiError.Unauthorized({}))),
          Effect.catchTag("UserState.InvalidInput", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
        ),
      )
      .handle("put", ({ payload, headers }) =>
        noStore.pipe(
          Effect.andThen(requireUser(headers["x-opencode-user-id"])),
          Effect.andThen(state.put(payload)),
          Effect.catchTag("UserState.Unauthenticated", () => Effect.fail(new HttpApiError.Unauthorized({}))),
          Effect.catchTag("UserState.InvalidInput", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
          Effect.catchTag("UserState.Conflict", (error) => Effect.fail(new UserStateConflict(error.current))),
        ),
      )
  }),
)
