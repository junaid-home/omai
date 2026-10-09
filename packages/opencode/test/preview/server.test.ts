import { describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "fs/promises"
import path from "path"
import {
  PreviewStartError,
  collectIdleServers,
  getDevServerStatus,
  startDevServer,
  stopDevServer,
} from "../../src/preview/server"
import { tmpdir } from "../fixture/fixture"

async function makePreviewProject(readyDelayMs: number) {
  return tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, "node_modules"))
      await writeFile(path.join(dir, "bun.lock"), "")
      await writeFile(
        path.join(dir, "dev-server.ts"),
        `import { createServer } from "node:http"\n` +
          `const s = createServer((_q, r) => r.end("ok"))\n` +
          `s.listen(0, () => setTimeout(() => console.log("ready on http://localhost:" + s.address().port), ${readyDelayMs}))\n`,
      )
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "preview-refcount-test", scripts: { dev: "bun dev-server.ts" } }),
      )
    },
  })
}

describe("preview.server start/stop refcount", () => {
  test("concurrent starts share one server and stops are balanced", async () => {
    await using tmp = await makePreviewProject(500)
    const first = await startDevServer(tmp.path)
    const second = await startDevServer(tmp.path)
    expect(second.port).toBe(first.port)
    expect(getDevServerStatus(tmp.path).running).toBe(true)
    expect(stopDevServer(tmp.path)).toBe(false)
    expect(getDevServerStatus(tmp.path).running).toBe(true)
    expect(stopDevServer(tmp.path)).toBe(true)
    expect(getDevServerStatus(tmp.path).running).toBe(false)
  })

  test("a stop while a start is in flight does not kill the server a sharer awaits", async () => {
    await using tmp = await makePreviewProject(2000)
    const first = startDevServer(tmp.path)
    const second = startDevServer(tmp.path)
    // The child delays its "ready" line, so the shared start stays in flight.
    // Wait past project detection so the server is registered, then stop before
    // the lock resolves: the stop must not terminate a server a sharer needs.
    await Bun.sleep(500)
    expect(stopDevServer(tmp.path)).toBe(false)
    const [a, b] = await Promise.all([first, second])
    expect(a.port).toBeGreaterThan(0)
    expect(b.port).toBe(a.port)
    expect(getDevServerStatus(tmp.path).running).toBe(true)
    expect(stopDevServer(tmp.path)).toBe(true)
  })
})

describe("preview.server start failures", () => {
  async function projectWithDevScript(script: string) {
    return tmpdir({
      init: async (dir) => {
        await mkdir(path.join(dir, "node_modules"))
        await writeFile(path.join(dir, "bun.lock"), "")
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "preview-fail", scripts: { dev: script } }))
      },
    })
  }

  test("a framework dev script that exits rejects with a non-static start error", async () => {
    await using tmp = await projectWithDevScript("exit 1")
    const error = await startDevServer(tmp.path).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PreviewStartError)
    expect((error as PreviewStartError).staticFallback).toBe(false)
    expect(getDevServerStatus(tmp.path).running).toBe(false)
  })

  test("a failed static serve still reports static fallback", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // A local `serve` binary keeps `npx serve` offline and makes it exit fast.
        await writeFile(path.join(dir, "index.html"), "<html><body>static</body></html>")
        await mkdir(path.join(dir, "node_modules/.bin"), { recursive: true })
        await writeFile(path.join(dir, "node_modules/.bin/serve"), "#!/bin/sh\nexit 1\n")
        await chmod(path.join(dir, "node_modules/.bin/serve"), 0o755)
      },
    })
    const error = await startDevServer(tmp.path).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PreviewStartError)
    expect((error as PreviewStartError).staticFallback).toBe(true)
  })
})

describe("preview.server idle sweep", () => {
  const now = 5_000_000
  const idleMs = 60_000

  test("collects only servers idle past the threshold", () => {
    const entries = [
      { directory: "/a", lastActive: now - 61_000 },
      { directory: "/b", lastActive: now - 60_000 },
      { directory: "/c", lastActive: now - 1_000 },
      { directory: "/d", lastActive: now },
    ]
    expect(collectIdleServers(entries, now, idleMs)).toEqual(["/a"])
  })

  test("treats the exact threshold as still active", () => {
    const entries = [{ directory: "/a", lastActive: now - idleMs }]
    expect(collectIdleServers(entries, now, idleMs)).toEqual([])
  })

  test("returns empty for no entries", () => {
    expect(collectIdleServers([], now, idleMs)).toEqual([])
  })
})
