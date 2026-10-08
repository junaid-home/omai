import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_unicode_test")
const NUL = "\u0000"

describe("SessionProjector invalid characters", () => {
  it.effect("persists a part containing NUL and unpaired surrogates instead of failing the jsonb insert", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      const messageID = SessionV1.MessageID.make("msg_nul")
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.Info)({
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4o" },
        }),
      })

      const partID = SessionV1.PartID.make("prt_nul")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 0,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "text",
          text: `before${NUL}after\uD800`,
        },
      })

      const part = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.id, partID))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      expect(part?.data).toMatchObject({ type: "text", text: "beforeafter\uFFFD" })
      expect(JSON.stringify(part?.data)).not.toContain("\\u0000")

      const storedEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .pipe(Effect.orDie)
      const partEvent = storedEvents.find((row) => (row.data as { part?: unknown }).part !== undefined)
      expect(partEvent).toBeDefined()
      expect(JSON.stringify(partEvent?.data)).not.toContain("\\u0000")
      expect(partEvent?.data).toMatchObject({ part: { text: "beforeafter\uFFFD" } })
    }),
  )
})
