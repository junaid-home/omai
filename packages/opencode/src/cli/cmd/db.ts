import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { psqlConnection } from "./db-connection"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive PostgreSQL shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.execute<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    // Keep both URI-authority and query-parameter login passwords out of process arguments.
    const config = Database.configFromEnvironment()
    const connection = psqlConnection(config)
    const child = spawn("psql", connection.args, {
      stdio: "inherit",
      env: { ...process.env, ...connection.env },
    })
    yield* Effect.tryPromise(
      () =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject)
          child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`psql exited with status ${code}`))))
        }),
    ).pipe(Effect.orDie)
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the PostgreSQL endpoint and schema with credentials removed",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    const config = Database.configFromEnvironment()
    const url = new URL(config.url)
    url.username = ""
    url.password = ""
    url.search = ""
    console.log(`${url.toString()} schema=${config.schema}`)
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
