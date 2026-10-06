import { expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))

it.effect("roundtrips native paths and safe bigint timestamps through PostgreSQL", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectID = ProjectV2.ID.make("codec_project")
    const sessionID = SessionSchema.ID.make("ses_codec")
    const worktree = AbsolutePath.make(process.platform === "win32" ? "C:\\Repo\\Thing" : "/repo/thing")
    const directory = process.platform === "win32" ? "C:\\Repo\\Thing\\packages\\api" : "/repo/thing/packages/api"
    const relative = process.platform === "win32" ? "packages\\api" : "packages/api"
    yield* db.insert(ProjectTable).values({
      id: projectID,
      worktree,
      sandboxes: [worktree],
      time_created: Number.MAX_SAFE_INTEGER,
      time_updated: 1,
    })
    yield* db.insert(SessionTable).values({
      id: sessionID,
      project_id: projectID,
      slug: "codec",
      directory,
      path: relative,
      title: "Codec",
      version: "test",
    })
    expect(
      yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).pipe(Database.first),
    ).toMatchObject({
      worktree,
      sandboxes: [worktree],
      time_created: Number.MAX_SAFE_INTEGER,
    })
    expect(
      yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).pipe(Database.first),
    ).toMatchObject({
      directory,
      path: "packages/api",
    })
    const rows = yield* db.execute<{ worktree: string; sandboxes: string }>(
      sql`SELECT worktree, sandboxes FROM ${ProjectTable} WHERE id = ${projectID}`,
    )
    expect(rows[0]).toEqual({
      worktree: worktree.replaceAll("\\", "/"),
      sandboxes: JSON.stringify([worktree.replaceAll("\\", "/")]),
    })
  }),
)

it.effect("rejects unsafe integers and invalid persisted paths instead of silently decoding them", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectID = ProjectV2.ID.make("invalid_codec_project")
    const badWrite = yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/repo"),
        sandboxes: [],
        time_created: Number.MAX_SAFE_INTEGER + 1,
      })
      .pipe(Effect.exit)
    expect(String(badWrite)).toContain("safe integer")
    expect(yield* db.select().from(ProjectTable)).toEqual([])

    yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/repo"), sandboxes: [] })
    yield* db.execute(sql`UPDATE ${ProjectTable} SET worktree = 'not-absolute' WHERE id = ${projectID}`)
    const badRead = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).pipe(Effect.exit)
    expect(String(badRead)).toContain("Path is not absolute")
  }),
)
