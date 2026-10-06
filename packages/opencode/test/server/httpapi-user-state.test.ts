import { NodeHttpServer } from "@effect/platform-node"
import { Authentication } from "@opencode-ai/core/authentication"
import { Database } from "@opencode-ai/core/database/database"
import { UserState } from "@opencode-ai/core/user-state"
import { UserTable } from "@opencode-ai/core/user/sql"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { UserStateApi } from "../../src/server/routes/instance/httpapi/groups/user-state"
import { userStateHandlers } from "../../src/server/routes/instance/httpapi/handlers/user-state"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  SchemaErrorMiddleware,
  schemaErrorLayer,
} from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const users: Record<string, Authentication.Principal> = Object.fromEntries(
  ["alice", "bob"].map((name) => [
    name,
    {
      userID: crypto.randomUUID(),
      sessionID: crypto.randomUUID(),
      username: `state-${name}-${crypto.randomUUID()}`,
      email: `${name}-${crypto.randomUUID()}@example.invalid`,
      instanceID: process.env.OPENCODE_INSTANCE_ID!,
    },
  ]),
)

// Authentication itself is tested separately. This boundary supplies already
// verified principals; all HTTP handlers and persistence below it are real.
const identity = Layer.succeed(
  Authorization,
  Authorization.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* effect.pipe(
        Effect.provideService(Authentication.Current, users[request.headers["x-test-principal"] ?? ""]),
      )
    }),
  ),
)

const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(HttpApi.make("opencode-root").addHttpApi(UserStateApi).middleware(SchemaErrorMiddleware)).pipe(
      Layer.provide(userStateHandlers),
      Layer.provide(UserState.layer),
      Layer.provide(identity),
      Layer.provide(schemaErrorLayer),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())),
  ),
)

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.insert(UserTable).values(
    Object.values(users).map((user) => ({
      id: user.userID,
      username: user.username,
      email: user.email,
      password_hash: "not-a-login-credential",
    })),
  )
})

const key = { namespace: "ui", key: "contract" } as const
const get = (name: string, expectedUserID?: string) =>
  HttpClientRequest.get("/user-state?namespace=ui&key=contract").pipe(
    HttpClientRequest.setHeaders({
      "x-test-principal": name,
      ...(expectedUserID ? { "x-opencode-user-id": expectedUserID } : {}),
    }),
    HttpClient.execute,
  )
const put = (name: string, expectedUserID: string, expectedRevision: number, value: string | null) =>
  HttpClientRequest.put("/user-state").pipe(
    HttpClientRequest.setHeaders({ "x-test-principal": name, "x-opencode-user-id": expectedUserID }),
    HttpClientRequest.setBody(HttpBody.jsonUnsafe({ ...key, expectedRevision, value })),
    HttpClient.execute,
  )

describe("user-state HTTP contract", () => {
  it.live("returns exact snapshots and no-store for success and conflict", () =>
    Effect.gen(function* () {
      yield* setup
      const missing = yield* get("alice", users.alice.userID)
      expect(missing.status).toBe(200)
      expect(missing.headers["cache-control"]).toBe("no-store")
      expect(yield* missing.json).toEqual({ revision: 0, value: null })
      const saved = yield* put("alice", users.alice.userID, 0, "saved")
      expect(saved.status).toBe(200)
      expect(yield* saved.json).toEqual({ revision: 1, value: "saved" })
      const conflict = yield* put("alice", users.alice.userID, 0, "stale")
      expect(conflict.status).toBe(409)
      expect(conflict.headers["cache-control"]).toBe("no-store")
      expect(yield* conflict.json).toEqual({ revision: 1, value: "saved" })
      const deleted = yield* put("alice", users.alice.userID, 1, null)
      expect(deleted.status).toBe(200)
      expect(yield* deleted.json).toEqual({ revision: 2, value: null })
    }),
  )

  it.live("rejects absent principals, absent identity preconditions and switched-account tabs", () =>
    Effect.gen(function* () {
      yield* setup
      yield* put("alice", users.alice.userID, 0, "alice-private")
      for (const response of yield* Effect.all(
        [
          get("", users.alice.userID),
          get("alice"),
          get("bob", users.alice.userID),
          put("bob", users.alice.userID, 0, "alice's stale tab"),
        ],
        { concurrency: "unbounded" },
      )) {
        expect(response.status).toBe(401)
        expect(yield* response.text).not.toContain("alice-private")
      }
      const bob = yield* get("bob", users.bob.userID)
      expect(yield* bob.json).toEqual({ revision: 0, value: null })
      const alice = yield* get("alice", users.alice.userID)
      expect(yield* alice.json).toEqual({ revision: 1, value: "alice-private" })
    }),
  )
})
