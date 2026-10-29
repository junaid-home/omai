import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { PlatformBuild } from "../../src/publish/platform-build"

const kind = (files: Record<string, string>) =>
  tmpdir({
    init: async (dir) => {
      await Promise.all(Object.entries(files).map(([name, text]) => Bun.write(path.join(dir, name), text)))
    },
  })

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps })

describe("PlatformBuild.platformKind", () => {
  test("static", async () => {
    await using tmp = await kind({ "index.html": "<html></html>" })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("static")
  })

  test("spa", async () => {
    await using tmp = await kind({ "package.json": pkg({ react: "*", "react-dom": "*", vite: "*" }) })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("spa")
  })

  test("astro server output", async () => {
    await using tmp = await kind({
      "package.json": pkg({ astro: "*" }),
      "astro.config.mjs": `export default { output: "server" }`,
    })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("astro-server")
  })

  test("astro with adapter", async () => {
    await using tmp = await kind({
      "package.json": pkg({ astro: "*" }),
      "astro.config.mjs": `export default { adapter: node() }`,
    })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("astro-server")
  })

  test("astro static", async () => {
    await using tmp = await kind({ "package.json": pkg({ astro: "*" }), "astro.config.mjs": `export default {}` })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("static-site")
  })

  test("gatsby is static-site", async () => {
    await using tmp = await kind({ "package.json": pkg({ gatsby: "*" }) })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("static-site")
  })

  test("next, nuxt, sveltekit", async () => {
    await using next = await kind({ "package.json": pkg({ next: "*" }) })
    await using nuxt = await kind({ "package.json": pkg({ nuxt: "*" }) })
    await using kit = await kind({ "package.json": pkg({ svelte: "*", "@sveltejs/kit": "*" }) })
    expect(await PlatformBuild.platformKind(next.path)).toBe("next")
    expect(await PlatformBuild.platformKind(nuxt.path)).toBe("nuxt")
    expect(await PlatformBuild.platformKind(kit.path)).toBe("sveltekit")
  })

  test("remix is rejected", async () => {
    await using tmp = await kind({ "package.json": pkg({ "@remix-run/react": "*", react: "*", "react-dom": "*" }) })
    await expect(PlatformBuild.platformKind(tmp.path)).rejects.toThrow("Remix isn't supported for publishing yet.")
  })

  test("nothing detected", async () => {
    await using tmp = await kind({ "readme.txt": "hi" })
    await expect(PlatformBuild.platformKind(tmp.path)).rejects.toThrow("No index.html found")
  })
})

describe("PlatformBuild.wranglerConfig", () => {
  test("spa", () => {
    expect(PlatformBuild.wranglerConfig("spa", { name: "x", directory: "/p/dist" })).toEqual({
      name: "x",
      compatibility_date: "2026-10-01",
      assets: { directory: "/p/dist", not_found_handling: "single-page-application" },
    })
  })

  test("static and static-site", () => {
    expect(PlatformBuild.wranglerConfig("static", { name: "x", directory: "/t" })).toMatchObject({
      assets: { directory: "/t", not_found_handling: "404-page" },
    })
    expect(PlatformBuild.wranglerConfig("static-site", { name: "x", directory: "/p/public" })).toMatchObject({
      assets: { directory: "/p/public", not_found_handling: "404-page" },
    })
  })

  test("next uses a generated config with only the OpenNext output", () => {
    expect(PlatformBuild.wranglerConfig("next", { name: "x", directory: "/p" })).toEqual({
      name: "x",
      compatibility_date: "2026-10-01",
      main: "/p/.open-next/worker.js",
      assets: { directory: "/p/.open-next/assets", binding: "ASSETS" },
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    })
  })

  test("server frameworks", () => {
    expect(PlatformBuild.wranglerConfig("astro-server", { name: "x", directory: "/p" })).toMatchObject({
      main: "/p/dist/_worker.js/index.js",
      assets: { directory: "/p/dist", binding: "ASSETS" },
      compatibility_flags: ["nodejs_compat"],
    })
    expect(PlatformBuild.wranglerConfig("nuxt", { name: "x", directory: "/p" })).toMatchObject({
      main: "/p/.output/server/index.mjs",
      assets: { directory: "/p/.output/public", binding: "ASSETS" },
    })
    expect(PlatformBuild.wranglerConfig("sveltekit", { name: "x", directory: "/p" })).toMatchObject({
      main: "/p/.svelte-kit/cloudflare/_worker.js",
      assets: { directory: "/p/.svelte-kit/cloudflare", binding: "ASSETS" },
    })
  })
})

describe("PlatformBuild.deployMode", () => {
  test("astro and nuxt use the redirected config when the build wrote one", async () => {
    await using tmp = await kind({ ".wrangler/deploy/config.json": `{"configPath":"../../dist/wrangler.json"}` })
    expect(await PlatformBuild.deployMode("astro-server", tmp.path)).toBe("redirected")
    expect(await PlatformBuild.deployMode("nuxt", tmp.path)).toBe("redirected")
    expect(await PlatformBuild.deployMode("sveltekit", tmp.path)).toBe("generated")
    expect(await PlatformBuild.deployMode("next", tmp.path)).toBe("generated")
  })

  test("falls back to the generated config without a redirected config", async () => {
    await using tmp = await kind({ "package.json": pkg({ astro: "*" }) })
    expect(await PlatformBuild.deployMode("astro-server", tmp.path)).toBe("generated")
    expect(await PlatformBuild.deployMode("nuxt", tmp.path)).toBe("generated")
  })
})

describe("PlatformBuild.buildEnv", () => {
  test("removes every CLOUDFLARE_ variable and keeps the rest", () => {
    expect(
      PlatformBuild.buildEnv({
        CLOUDFLARE_API_TOKEN: "secret",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_PLATFORM_ZONE: "omai.ch",
        PATH: "/usr/bin",
        NODE_ENV: "production",
      }),
    ).toEqual({ PATH: "/usr/bin", NODE_ENV: "production" })
  })
})

describe("PlatformBuild helpers", () => {
  test("vite project with root index.html is spa", async () => {
    await using tmp = await kind({
      "package.json": pkg({ react: "*", "react-dom": "*", vite: "*" }),
      "index.html": "<html></html>",
    })
    expect(await PlatformBuild.platformKind(tmp.path)).toBe("spa")
  })

  test("astroHasServer", async () => {
    await using server = await kind({ "astro.config.mjs": `export default { output: 'server' }` })
    await using adapter = await kind({ "astro.config.ts": `export default { adapter: cloudflare() }` })
    await using plain = await kind({ "astro.config.mjs": `export default {}` })
    expect(await PlatformBuild.astroHasServer(server.path)).toBe(true)
    expect(await PlatformBuild.astroHasServer(adapter.path)).toBe(true)
    expect(await PlatformBuild.astroHasServer(plain.path)).toBe(false)
  })

  test("useCloudflareAdapter", async () => {
    const config = (name: string) => `import adapter from "@sveltejs/${name}"\nexport default { kit: { adapter: adapter() } }\n`
    const rewritten = config("adapter-cloudflare")
    for (const [from, expected] of [
      ["adapter-auto", rewritten],
      ["adapter-cloudflare-workers", rewritten],
      ["adapter-cloudflare", rewritten],
    ]) {
      await using tmp = await kind({ "svelte.config.js": config(from) })
      await PlatformBuild.useCloudflareAdapter(tmp.path)
      expect(await Bun.file(path.join(tmp.path, "svelte.config.js")).text()).toBe(expected)
    }
  })

  test("copyStaticFiles excludes secrets and git", async () => {
    await using tmp = await kind({
      "index.html": "hi",
      "css/a.css": "a",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      ".git/config": "x",
    })
    await using out = await tmpdir()
    await PlatformBuild.copyStaticFiles(tmp.path, out.path)
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: out.path, dot: true }))).sort()
    expect(files).toEqual(["css/a.css", "index.html"])
  })
})
