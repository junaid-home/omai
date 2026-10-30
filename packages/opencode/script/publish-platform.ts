#!/usr/bin/env bun
// Idempotent setup for the Workers for Platforms publishing stack. Run from packages/opencode.
import { Effect, Schema } from "effect"
import { $ } from "bun"
import { mkdtemp } from "fs/promises"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { CloudflarePlatform } from "../src/publish/cloudflare-platform"
import { PlatformName } from "../src/publish/platform-name"

const PLATFORM = CloudflarePlatform.PLATFORM
const decodeKv = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })))
const decodeRecords = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String })),
)
const decodeCreated = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))

function log(resource: string, existed: boolean) {
  console.log(`${existed ? "exists" : "created"}  ${resource}`)
}

function found<A>(effect: Effect.Effect<A, Error>) {
  return effect.pipe(
    Effect.as(true),
    Effect.catch((e) => (CloudflarePlatform.isStatus(e, 404) ? Effect.succeed(false) : Effect.fail(e))),
  )
}

const program = Effect.gen(function* () {
  const zone = yield* CloudflarePlatform.zoneId()
  const wildcard = `*.${PLATFORM.zone}`

  // 1. Dispatch namespace
  const namespaceExists = yield* found(CloudflarePlatform.account(`/workers/dispatch/namespaces/${PLATFORM.namespace}`))
  if (!namespaceExists)
    yield* CloudflarePlatform.account(`/workers/dispatch/namespaces`, {
      method: "POST",
      body: JSON.stringify({ name: PLATFORM.namespace }),
    })
  log(`dispatch namespace ${PLATFORM.namespace}`, namespaceExists)

  // 2. KV namespace
  const kvList = decodeKv(yield* CloudflarePlatform.account(`/storage/kv/namespaces?per_page=100`))
  const kvFound = kvList._tag === "Some" ? kvList.value.find((n) => n.title === PLATFORM.kvTitle) : undefined
  const kvId = kvFound
    ? kvFound.id
    : yield* CloudflarePlatform.account(`/storage/kv/namespaces`, {
        method: "POST",
        body: JSON.stringify({ title: PLATFORM.kvTitle }),
      }).pipe(
        Effect.flatMap((result) => {
          const created = decodeCreated(result)
          if (created._tag === "None") return Effect.fail(new Error("Unexpected KV namespace response"))
          return Effect.succeed(created.value.id)
        }),
      )
  log(`kv namespace ${PLATFORM.kvTitle}`, !!kvFound)

  // 3. Wildcard DNS record. A bad response must stop the script: an empty list would skip bypass routes.
  const records = decodeRecords(yield* CloudflarePlatform.listAll(`/zones/${zone}/dns_records`))
  if (records._tag === "None") return yield* Effect.fail(new Error("Unexpected DNS records response; aborting"))
  const routed = records.value.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type))
  const hasWildcard = routed.some((r) => r.name === wildcard)
  if (!hasWildcard)
    yield* CloudflarePlatform.call(`/zones/${zone}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "AAAA", name: "*", content: "100::", proxied: true }),
    })
  log(`dns ${wildcard}`, hasWildcard)

  // 4. Bypass routes keep existing hostnames, and the apex, away from the
  // dispatcher's `*/*` custom-hostname route
  const hosts = new Set([
    PLATFORM.zone,
    ...routed.map((r) => r.name).filter((name) => name !== wildcard),
    ...[...PlatformName.RESERVED].map((name) => `${name}.${PLATFORM.zone}`),
  ])
  console.log(`bypass routes for ${hosts.size} hosts:\n${[...hosts].map((host) => `  ${host}`).join("\n")}`)
  for (const host of hosts) {
    const pattern = `${host}/*`
    const existed = yield* CloudflarePlatform.routeExists(pattern)
    yield* CloudflarePlatform.addRoute(pattern)
    log(`route ${pattern} (bypass)`, existed)
  }

  // 5. Deploy the dispatcher
  const dispatcherExists = yield* found(CloudflarePlatform.account(`/workers/scripts/${PLATFORM.dispatcher}`))
  const config = path.join(
    yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "omai-dispatcher-"))),
    "wrangler.json",
  )
  yield* Effect.promise(async () => {
    await Bun.write(
      config,
      JSON.stringify({
        name: PLATFORM.dispatcher,
        main: fileURLToPath(new URL("../src/publish/dispatcher/index.ts", import.meta.url)),
        compatibility_date: new Date().toISOString().slice(0, 10),
        dispatch_namespaces: [{ binding: "DISPATCHER", namespace: PLATFORM.namespace }],
        kv_namespaces: [{ binding: "HOSTNAMES", id: kvId }],
        vars: { ZONE: PLATFORM.zone },
        workers_dev: false,
        preview_urls: false,
      }),
    )
    await $`npx wrangler deploy --config ${config}`
  })
  log(`worker ${PLATFORM.dispatcher}`, dispatcherExists)

  // 6. Dispatcher route, after the script exists so it never points at a missing Worker
  const dispatcherPattern = `${wildcard}/*`
  const routeExisted = yield* CloudflarePlatform.routeExists(dispatcherPattern)
  yield* CloudflarePlatform.addRoute(dispatcherPattern, PLATFORM.dispatcher)
  log(`route ${dispatcherPattern} -> ${PLATFORM.dispatcher}`, routeExisted)

  // 7. Custom hostnames (Cloudflare for SaaS) arrive on this zone under the
  // customer's hostname. Cloudflare only accepts route patterns within the
  // zone, so one `*/*` route catches them all; the bypass routes above are
  // more specific and keep omai.ch's own hosts out of it.
  const saasPattern = "*/*"
  const saasExisted = yield* CloudflarePlatform.routeExists(saasPattern)
  yield* CloudflarePlatform.addRoute(saasPattern, PLATFORM.dispatcher)
  log(`route ${saasPattern} -> ${PLATFORM.dispatcher}`, saasExisted)
  console.log(
    `\nReminder: re-run this script after adding new DNS records to ${PLATFORM.zone} so they get bypass routes.`,
  )
})

await Effect.runPromise(program).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
