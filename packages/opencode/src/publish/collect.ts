import { Effect } from "effect"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"
import { readdir, readFile, stat } from "fs/promises"
import { exec } from "child_process"
import path from "path"

const PUBLISH_EXTRA_IGNORE = ["**/.env*", "**/.git/**", "**/.DS_Store", "**/node_modules/**"]

function shouldInclude(relativePath: string): boolean {
  if (Ignore.match(relativePath, { extra: PUBLISH_EXTRA_IGNORE })) return false
  return true
}

async function collectFilesFromDir(dir: string, root: string, files: Map<string, Buffer>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(dir, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join("/")

    if (!shouldInclude(relative)) continue

    if (entry.isDirectory()) {
      await collectFilesFromDir(absolute, root, files)
      continue
    }

    if (!entry.isFile()) continue

    const content = await readFile(absolute)
    files.set(relative, content)
  }
}

export function collectProjectFiles(directory: string): Effect.Effect<Map<string, Buffer>> {
  return Effect.tryPromise(async () => {
    const root = path.resolve(directory)
    const files = new Map<string, Buffer>()
    await collectFilesFromDir(root, root, files)
    return files
  })
}

export interface FrameworkInfo {
  name: string
  buildCommand: string
  outputDir: string
  configFiles: string[]
  runtime?: boolean
}

export const FRAMEWORKS: FrameworkInfo[] = [
  {
    name: "next",
    buildCommand: "npx next build",
    outputDir: "out",
    configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
    runtime: true,
  },
  {
    name: "nuxt",
    buildCommand: "npx nuxt build",
    outputDir: ".output/public",
    configFiles: ["nuxt.config.ts", "nuxt.config.js"],
    runtime: true,
  },
  {
    name: "sveltekit",
    buildCommand: "npx vite build",
    outputDir: "build",
    configFiles: ["svelte.config.js", "svelte.config.ts"],
    runtime: true,
  },
  {
    name: "vite-react",
    buildCommand: "npx vite build",
    outputDir: "dist",
    configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
  },
  {
    name: "vite-vue",
    buildCommand: "npx vite build",
    outputDir: "dist",
    configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
  },
  {
    name: "vite-svelte",
    buildCommand: "npx vite build",
    outputDir: "dist",
    configFiles: ["svelte.config.js", "svelte.config.ts"],
  },
  {
    name: "solid",
    buildCommand: "npx vite build",
    outputDir: "dist",
    configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
  },
  {
    name: "gatsby",
    buildCommand: "npx gatsby build",
    outputDir: "public",
    configFiles: ["gatsby-config.js", "gatsby-config.ts", "gatsby-config.mjs"],
  },
  {
    name: "create-react-app",
    buildCommand: "npx react-scripts build",
    outputDir: "build",
    configFiles: ["craco.config.js", "craco.config.ts"],
  },
  {
    name: "angular",
    buildCommand: "npx ng build",
    outputDir: "dist",
    configFiles: ["angular.json"],
  },
  {
    name: "astro",
    buildCommand: "npx astro build",
    outputDir: "dist",
    configFiles: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
  },
  {
    name: "remix",
    buildCommand: "npx remix vite:build",
    outputDir: "build/client",
    configFiles: ["remix.config.js", "remix.config.ts"],
    runtime: true,
  },
  {
    name: "ember",
    buildCommand: "npx ember build",
    outputDir: "dist",
    configFiles: ["ember-cli-build.js"],
  },
  {
    name: "hugo",
    buildCommand: "hugo",
    outputDir: "public",
    configFiles: ["hugo.toml", "hugo.yaml", "config.toml", "config.yaml"],
  },
  {
    name: "eleventy",
    buildCommand: "npx @11ty/eleventy",
    outputDir: "_site",
    configFiles: [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs"],
  },
]

export async function detectFramework(directory: string): Promise<FrameworkInfo | null> {
  const pkgPath = path.join(directory, "package.json")
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  } catch {
    return null
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  }

  if (deps["next"]) {
    return {
      name: "next",
      buildCommand: "npx next build",
      outputDir: "out",
      configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
      runtime: true,
    }
  }
  if (deps["astro"]) return FRAMEWORKS.find((f) => f.name === "astro")!
  if (deps["@angular/core"]) return FRAMEWORKS.find((f) => f.name === "angular")!
  if (deps["nuxt"] || deps["@nuxt/kit"]) return FRAMEWORKS.find((f) => f.name === "nuxt")!
  if (deps["gatsby"]) return FRAMEWORKS.find((f) => f.name === "gatsby")!
  if (deps["ember-cli"] || deps["@ember/ember-cli-build"]) return FRAMEWORKS.find((f) => f.name === "ember")!

  if (deps["solid-js"]) return FRAMEWORKS.find((f) => f.name === "solid")!

  if (deps["react"] && deps["react-dom"]) {
    if (deps["@remix-run/react"]) return FRAMEWORKS.find((f) => f.name === "remix")!
    if (deps["vite"]) return FRAMEWORKS.find((f) => f.name === "vite-react")!
    if (deps["react-scripts"]) return FRAMEWORKS.find((f) => f.name === "create-react-app")!
    return FRAMEWORKS.find((f) => f.name === "vite-react")!
  }

  if (deps["vue"]) {
    if (deps["nuxt"]) return FRAMEWORKS.find((f) => f.name === "nuxt")!
    return FRAMEWORKS.find((f) => f.name === "vite-vue")!
  }

  if (deps["svelte"]) {
    if (deps["@sveltejs/kit"]) return FRAMEWORKS.find((f) => f.name === "sveltekit")!
    return FRAMEWORKS.find((f) => f.name === "vite-svelte")!
  }

  for (const fw of FRAMEWORKS) {
    for (const file of fw.configFiles) {
      try {
        await stat(path.join(directory, file))
        return fw
      } catch {}
    }
  }

  return null
}

export async function runBuild(
  directory: string,
  framework: FrameworkInfo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pkgPath = path.join(directory, "package.json")
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  } catch {
    throw new Error("Cannot read package.json")
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {}
  const buildCmd = scripts["build"] ? `npm run build` : framework.buildCommand

  await new Promise<void>((resolve, reject) => {
    const child = exec(buildCmd, { cwd: directory, env: { ...env, NODE_ENV: "production" } })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Build failed (exit ${code}): ${stderr.slice(-500)}`))
      } else {
        resolve()
      }
    })
    child.on("error", reject)
  })

  const outputDir = path.join(directory, framework.outputDir)
  try {
    await stat(outputDir)
  } catch {
    throw new Error(`Build output directory "${framework.outputDir}" not found after build.`)
  }

  return outputDir
}

export interface DeployDirectory {
  directory: string
  isStatic: boolean
  framework: string | null
  runtime: boolean
}

export async function resolveDeployDirectory(directory: string): Promise<DeployDirectory> {
  const indexHtml = path.join(directory, "index.html")
  try {
    await stat(indexHtml)
    return { directory, isStatic: true, framework: null, runtime: false }
  } catch {}

  const framework = await detectFramework(directory)
  if (!framework) {
    throw new Error(
      `No index.html found and no supported framework detected in ${directory}.\n` +
        `Supported frameworks: React, Vue, Svelte, Next.js, Nuxt, Gatsby, Angular.\n` +
        `For static sites, ensure index.html exists at the project root.`,
    )
  }

  if (framework.runtime) {
    return { directory, isStatic: false, framework: framework.name, runtime: true }
  }

  const outputDir = await runBuild(directory, framework)
  return { directory: outputDir, isStatic: false, framework: framework.name, runtime: false }
}

export function isStaticProject(directory: string): Effect.Effect<boolean> {
  return Effect.tryPromise(async () => {
    const indexHtml = path.join(directory, "index.html")
    try {
      await stat(indexHtml)
      return true
    } catch {
      return false
    }
  })
}
