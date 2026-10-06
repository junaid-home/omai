import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Todo } from "@/session/todo"
import { SessionID } from "@/session/schema"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Workspace.node, Database.node, Ripgrep.node, Todo.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

const responseJson = (response: HttpClientResponse.HttpClientResponse) => response.json

// Frames events at the SSE `data:` line level so a single transport chunk that
// coalesces several events still yields one frame per read.
const openEventFrames = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const frames = yield* Queue.unbounded<{ id?: string; type: string; properties: unknown }>()
    yield* response.stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("data: ")),
      Stream.map((line) => Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice("data: ".length)))),
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.forkScoped,
    )
    return frames
  })

const readFrame = (frames: Queue.Dequeue<{ id?: string; type: string; properties: unknown }>) =>
  Queue.take(frames).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for event")),
    }),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live(
    "replays busy status and current todos on reconnect while a session is working",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.hang
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

        // Create the session over HTTP so the route-side instance is fully
        // loaded before any event stream connects; otherwise the run's lazy
        // instance bootstrap emits server.instance.disposed and closes streams.
        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        const session = yield* responseJson(created).pipe(Effect.map((value) => value as { id: string }))

        const sessionID = Schema.decodeUnknownSync(SessionID)(session.id)

        const todo = yield* Todo.Service
        yield* todo
          .update({
            sessionID,
            todos: [{ content: "inspect", status: "in_progress", priority: "high" }],
          })
          .pipe(provideInstanceEffect(directory))

        // The forkScoped prompt keeps the run in-flight; wait(1) resolves once
        // the busy LLM call is queued by the mock server.
        yield* requestInDirectory(`/session/${session.id}/message`, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello" }],
          }),
        }).pipe(Effect.forkScoped)
        yield* llm.wait(1)

        // Reconnect (simulating a page refresh) and assert the snapshot
        // replays the working session's status and current todos.
        const frames = yield* openEventFrames(directory)
        expect(yield* readFrame(frames)).toMatchObject({ type: "server.connected", properties: {} })
        expect(yield* readFrame(frames)).toMatchObject({
          type: "session.status",
          properties: { sessionID, status: { type: "busy" } },
        })
        expect(yield* readFrame(frames)).toMatchObject({
          type: "todo.updated",
          properties: {
            sessionID,
            todos: [{ content: "inspect", status: "in_progress", priority: "high" }],
          },
        })
      }).pipe(
        Effect.provide(TestLLMServer.layer),
        Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)),
        Effect.provide(appLayer),
      ),
    20000,
  )

  it.live(
    "replays todos written by the run's todowrite tool on reconnect while work is in-flight",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const { promise, resolve } = Promise.withResolvers()

        const created = yield* requestInDirectory("/session", directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "replay tool todos",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        })
        expect(created.status).toBe(200)
        const session = yield* responseJson(created).pipe(Effect.map((value) => value as { id: string }))
        const sessionID = Schema.decodeUnknownSync(SessionID)(session.id)

        // Turn 1 writes the todo list through the real todowrite tool; turn 2
        // holds so the session stays busy mid-step (e.g. running a script) but
        // can be released for a clean teardown once the assertions pass.
        yield* llm.tool("todowrite", {
          todos: [
            { content: "setup", status: "completed", priority: "high" },
            { content: "execute script", status: "in_progress", priority: "high" },
            { content: "verify", status: "pending", priority: "medium" },
          ],
        })
        const release = Effect.sync(() => resolve())
        yield* llm.hold("done", promise)
        yield* requestInDirectory(`/session/${session.id}/message`, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello" }],
          }),
        }).pipe(Effect.forkScoped)

        // The run is busy once its second (held) LLM call is queued.
        yield* llm.wait(2)

        // The todowrite tool has committed the list by now, and the second turn
        // is still held, so the run stays busy mid-step.
        const todo = yield* Todo.Service
        const written = yield* todo.get(sessionID).pipe(provideInstanceEffect(directory))
        expect(written).toEqual([
          { content: "setup", status: "completed", priority: "high" },
          { content: "execute script", status: "in_progress", priority: "high" },
          { content: "verify", status: "pending", priority: "medium" },
        ])
        const viaHttp = yield* requestInDirectory(`/session/${session.id}/todo`, directory)
        expect(viaHttp.status).toBe(200)

        // Reconnect (simulating a page refresh) and assert the snapshot
        // replays the busy status and the todos the run's todowrite tool
        // has written so far.
        const frames = yield* openEventFrames(directory)
        expect(yield* readFrame(frames)).toMatchObject({ type: "server.connected", properties: {} })
        expect(yield* readFrame(frames)).toMatchObject({
          type: "session.status",
          properties: { sessionID, status: { type: "busy" } },
        })
        expect(yield* readFrame(frames)).toMatchObject({
          type: "todo.updated",
          properties: {
            sessionID,
            todos: [
              { content: "setup", status: "completed", priority: "high" },
              { content: "execute script", status: "in_progress", priority: "high" },
              { content: "verify", status: "pending", priority: "medium" },
            ],
          },
        })
        yield* release
      }).pipe(
        Effect.provide(TestLLMServer.layer),
        Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)),
        Effect.provide(appLayer),
      ),
    30000,
  )
})
