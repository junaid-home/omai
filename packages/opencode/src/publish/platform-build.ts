export * as PlatformBuild from "./platform-build"

import { Effect } from "effect"
import { exec } from "child_process"
import { mkdtemp, readFile, rm, stat } from "fs/promises"
import os from "os"
import path from "path"
import { CloudflarePlatform } from "./cloudflare-platform"
import { collectProjectFiles, detectFramework, runBuild } from "./collect"
import { buildForWorkers, installDependencies, migrateConfig } from "./cloudflare-workers"

export type PlatformKind = "static" | "spa" | "static-site" | "astro-server" | "next" | "nuxt" | "sveltekit"

const COMPATIBILITY_DATE = "2026-10-01"

export async function platformKind(directory: string): Promise<PlatformKind> {
  const framework = await detectFramework(directory)
  if (!framework) {
    // A root index.html only means "static" when no framework owns the project (Vite also has one).
    if (await exists(path.join(directory, "index.html"))) return "static"
    throw new Error(
      `No index.html found and no supported framework detected in ${directory}.\n` +
        `Supported frameworks: React, Vue, Svelte, Next.js, Nuxt, Gatsby, Angular.\n` +
        `For static sites, ensure index.html exists at the project root.`,
    )
  }

  if (framework.name === "remix") throw new Error("Remix isn't supported for publishing yet.")
  if (framework.name === "next") return "next"
  if (framework.name === "nuxt") return "nuxt"
  if (framework.name === "sveltekit") return "sveltekit"
  if (framework.name === "astro") return (await astroHasServer(directory)) ? "astro-server" : "static-site"
  if (["hugo", "eleventy", "gatsby"].includes(framework.name)) return "static-site"
  return "spa"
}

/** Generated wrangler config. The project's own wrangler config is never uploaded, so its bindings can't leak in. */
export function wranglerConfig(kind: PlatformKind, input: { name: string; directory: string }) {
  const base = { name: input.name, compatibility_date: COMPATIBILITY_DATE }
  const server = (main: string, assets: string, flags = ["nodejs_compat"]) => ({
    ...base,
    main: path.join(input.directory, main),
    assets: { directory: path.join(input.directory, assets), binding: "ASSETS" },
    compatibility_flags: flags,
  })

  if (kind === "static" || kind === "static-site")
    return { ...base, assets: { directory: input.directory, not_found_handling: "404-page" } }
  if (kind === "spa")
    return { ...base, assets: { directory: input.directory, not_found_handling: "single-page-application" } }
  if (kind === "next")
    return server(".open-next/worker.js", ".open-next/assets", ["nodejs_compat", "global_fetch_strictly_public"])
  if (kind === "astro-server") return server("dist/_worker.js/index.js", "dist")
  if (kind === "nuxt") return server(".output/server/index.mjs", ".output/public")
  return server(".svelte-kit/cloudflare/_worker.js", ".svelte-kit/cloudflare")
}

/**
 * Astro and Nuxt adapters may write a redirected wrangler config to `.wrangler/deploy/config.json`;
 * wrangler then picks it up when run from the project without `--config`.
 */
export async function deployMode(kind: PlatformKind, directory: string): Promise<"redirected" | "generated"> {
  if (kind !== "astro-server" && kind !== "nuxt") return "generated"
  return (await exists(path.join(directory, ".wrangler", "deploy", "config.json"))) ? "redirected" : "generated"
}

/** Build and install commands run user code, so they never see the shared Cloudflare credentials. */
export function buildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("CLOUDFLARE_")))
}

export function deployToPlatform(directory: string, name: string): Effect.Effect<{ id: string; url: string }, Error> {
  return Effect.gen(function* () {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return yield* Effect.fail(new Error("Invalid app name"))
    const kind = yield* Effect.tryPromise({ try: () => platformKind(directory), catch: toError })
    yield* CloudflarePlatform.ensurePlatform()
    return yield* Effect.tryPromise({ try: () => deploy(kind, directory, name), catch: toError })
  })
}

function toError(e: unknown) {
  return new Error(String((e as Error)?.message ?? e))
}

async function deploy(kind: PlatformKind, directory: string, name: string) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID environment variable")
  if (!token) throw new Error("Missing CLOUDFLARE_API_TOKEN environment variable")
  const env = { ...buildEnv(), CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }
  const wrangler = `npx wrangler deploy --dispatch-namespace ${CloudflarePlatform.PLATFORM.namespace} --name ${name}`

  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-platform-"))
  try {
    const base = await prepare(kind, directory, tmp)
    const redirected = (await deployMode(kind, directory)) === "redirected"
    const file = path.join(tmp, "wrangler.json")
    if (!redirected) await Bun.write(file, JSON.stringify(wranglerConfig(kind, { name, directory: base }), null, 2))
    await run(redirected ? wrangler : `${wrangler} --config ${file}`, directory, env, "Wrangler deploy failed")
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }

  return { id: "platform-" + Date.now(), url: `https://${name}.${CloudflarePlatform.PLATFORM.zone}` }
}

/** Builds the project and returns the directory that `wranglerConfig` should be based on. */
async function prepare(kind: PlatformKind, directory: string, tmp: string) {
  if (kind === "static") return copyStaticFiles(directory, path.join(tmp, "assets"))
  if (kind === "next") {
    await installDependencies(directory, buildEnv())
    await migrateConfig(directory, buildEnv())
    await buildForWorkers(directory, buildEnv())
    return directory
  }

  const framework = await detectFramework(directory)
  if (!framework) throw new Error(`No supported framework detected in ${directory}.`)
  if (kind === "spa" || kind === "static-site") return runBuild(directory, framework, buildEnv())

  const env = { ...buildEnv(), NODE_ENV: "production", ...(kind === "nuxt" ? { NITRO_PRESET: "cloudflare_module" } : {}) }
  if (kind === "astro-server") await useCloudflareAstro(directory)
  if (kind === "sveltekit") {
    await ensureDependency(directory, "@sveltejs/adapter-cloudflare")
    await useCloudflareAdapter(directory)
  }
  await run(await buildCommand(directory, framework.buildCommand), directory, env, "Build failed")
  return directory
}

/** Copies only collected files (no .env, .git, node_modules) so they are never uploaded. */
export async function copyStaticFiles(directory: string, destination: string) {
  const files = await Effect.runPromise(collectProjectFiles(directory))
  await Promise.all([...files.entries()].map(([file, content]) => Bun.write(path.join(destination, file), content)))
  return destination
}

async function useCloudflareAstro(directory: string) {
  const config = await readAstroConfig(directory)
  if (!config.includes("@astrojs/cloudflare"))
    return run("npx astro add cloudflare --yes", directory, buildEnv(), "Failed to add Astro Cloudflare adapter")
  return ensureDependency(directory, "@astrojs/cloudflare")
}

async function readAstroConfig(directory: string) {
  return Promise.all(
    ["astro.config.mjs", "astro.config.ts", "astro.config.js"].map((file) =>
      readFile(path.join(directory, file), "utf-8").catch(() => ""),
    ),
  ).then((texts) => texts.join("\n"))
}

export async function astroHasServer(directory: string) {
  const config = await readAstroConfig(directory)
  return /output:\s*["'](server|hybrid)["']/.test(config) || /\badapter\s*:/.test(config)
}

async function ensureDependency(directory: string, dependency: string) {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf-8"))
  if (pkg.dependencies?.[dependency] || pkg.devDependencies?.[dependency]) return
  await run(`npm install ${dependency}@latest --save-dev`, directory, buildEnv(), "Failed to install dependencies")
}

export async function useCloudflareAdapter(directory: string) {
  const file = await Promise.all(
    ["svelte.config.js", "svelte.config.ts"].map(async (name) => ((await exists(path.join(directory, name))) ? name : "")),
  ).then((names) => names.find(Boolean))
  if (!file) return
  const config = path.join(directory, file)
  const text = await readFile(config, "utf-8")
  // "-workers" is the deprecated adapter, so it must still be rewritten.
  if (/@sveltejs\/adapter-cloudflare(?!-workers)/.test(text)) return
  await Bun.write(config, text.replace(/@sveltejs\/adapter-[\w-]+/g, "@sveltejs/adapter-cloudflare"))
}

async function buildCommand(directory: string, fallback: string) {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf-8"))
  return pkg.scripts?.build ? "npm run build" : fallback
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

function run(command: string, cwd: string, env: NodeJS.ProcessEnv, failure: string) {
  return new Promise<void>((resolve, reject) => {
    const child = exec(command, { cwd, env })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${failure} (exit ${code}): ${stderr.slice(-2000)}`))
      resolve()
    })
    child.on("error", reject)
  })
}
