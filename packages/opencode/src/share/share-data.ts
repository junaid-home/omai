import { Database } from "@opencode-ai/core/database/database"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

// Shared sessions are served straight from the database the VMs write to, in
// the item format the web share page reads (the same shape the hosted share
// service used to return). Only a session with a share row is ever exposed,
// and never the share's secret.
export const read = Effect.fn("ShareData.read")(function* (shareID: string) {
  const { db } = yield* Database.Service
  const session = yield* Session.Service
  const row = yield* db
    .select({ sessionID: SessionShareTable.session_id })
    .from(SessionShareTable)
    .where(eq(SessionShareTable.id, shareID))
    .pipe(Database.first)
    .pipe(Effect.orDie)
  if (!row) return undefined
  const sessionID = SessionID.make(row.sessionID)
  const info = yield* session.get(sessionID).pipe(Effect.catchTag("NotFoundError", () => Effect.void))
  if (!info) return undefined
  const messages = yield* session
    .messages({ sessionID })
    .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([])))
  return [
    { type: "session" as const, data: info },
    ...messages.map((item) => ({ type: "message" as const, data: item.info })),
    ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
    { type: "session_diff" as const, data: yield* session.diff(sessionID) },
    { type: "model" as const, data: [] },
  ]
})

export * as ShareData from "./share-data"
