import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// An OpenAI-compatible endpoint answering every completion with `reply`,
// recording which model each request named.
function completions(reply: string) {
  const models: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string }
      models.push(body.model)
      return Response.json({
        id: "cmpl",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, models, [Symbol.dispose]: () => server.stop(true) }
}

describe("file HttpApi", () => {
  test("visual edits are applied with the model selected in the chat", async () => {
    using llm = completions(
      JSON.stringify([{ path: "index.html", find: "<h1>Unchanged</h1>", replace: "<h1>Changed</h1>" }]),
    )
    const base = testProviderConfig(llm.url)
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...base,
        // A configured visual-editor model must not win over the chat's choice.
        visual_editor_model: "test/test-model",
        provider: {
          ...base.provider,
          chat: {
            ...base.provider.test,
            id: "chat",
            name: "Chat",
            models: {
              "chat-model": { ...base.provider.test.models["test-model"], id: "chat-model", name: "Chat Model" },
            },
          },
        },
      },
    })
    await Bun.write(path.join(tmp.path, "index.html"), "<h1>Unchanged</h1>")

    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${FilePaths.visualEdit}`, {
        method: "POST",
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
        body: JSON.stringify({
          modifiedHtml: "<h1>Changed</h1>",
          changes: [{ selector: "h1", type: "text", content: "Changed", sourcePath: "index.html" }],
          model: { providerID: "chat", modelID: "chat-model" },
        }),
      }),
      context,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, filesWritten: ["index.html"] })
    expect(llm.models).toEqual(["chat-model"])
    expect(await Bun.file(path.join(tmp.path, "index.html")).text()).toBe("<h1>Changed</h1>")
  })

  test("a visual edit falls back to the next model when one fails", async () => {
    using llm = completions(
      JSON.stringify([{ path: "index.html", find: "<h1>Unchanged</h1>", replace: "<h1>Changed</h1>" }]),
    )
    const base = testProviderConfig(llm.url)
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...base,
        // Tried first and down; the deployment's default model still works.
        visual_editor_model: "down/test-model",
        model: "test/test-model",
        provider: {
          ...base.provider,
          // A provider that is down (rate-limited, outage).
          down: {
            ...base.provider.test,
            id: "down",
            name: "Down",
            options: { apiKey: "k", baseURL: "http://127.0.0.1:1" },
          },
        },
      },
    })
    await Bun.write(path.join(tmp.path, "index.html"), "<h1>Unchanged</h1>")

    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${FilePaths.visualEdit}`, {
        method: "POST",
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
        body: JSON.stringify({
          modifiedHtml: "<h1>Changed</h1>",
          changes: [{ selector: "h1", type: "text", content: "Changed", sourcePath: "index.html" }],
        }),
      }),
      context,
    )

    expect(await response.json()).toMatchObject({ success: true, filesWritten: ["index.html"] })
    expect(llm.models).toEqual(["test-model"])
  })

  test("a visual edit never switches away from the chat's model", async () => {
    using llm = completions(
      JSON.stringify([{ path: "index.html", find: "<h1>Unchanged</h1>", replace: "<h1>Changed</h1>" }]),
    )
    const base = testProviderConfig(llm.url)
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...base,
        // A working fallback the save must not use instead of the chat's model.
        visual_editor_model: "test/test-model",
        provider: {
          ...base.provider,
          down: {
            ...base.provider.test,
            id: "down",
            name: "Down",
            options: { apiKey: "k", baseURL: "http://127.0.0.1:1" },
          },
        },
      },
    })
    await Bun.write(path.join(tmp.path, "index.html"), "<h1>Unchanged</h1>")

    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${FilePaths.visualEdit}`, {
        method: "POST",
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
        body: JSON.stringify({
          modifiedHtml: "<h1>Changed</h1>",
          changes: [{ selector: "h1", type: "text", content: "Changed", sourcePath: "index.html" }],
          model: { providerID: "down", modelID: "test-model" },
        }),
      }),
      context,
    )

    const body = (await response.json()) as { success: boolean; error?: string }
    expect(body.success).toBe(false)
    expect(body.error).toStartWith("down/test-model: ")
    expect(llm.models).toEqual([])
    expect(await Bun.file(path.join(tmp.path, "index.html")).text()).toBe("<h1>Unchanged</h1>")
  })

  test("a visual edit that cannot reach any model says why", async () => {
    await using tmp = await tmpdir({ git: true, config: testProviderConfig("http://127.0.0.1:1") })
    await Bun.write(path.join(tmp.path, "index.html"), "<h1>Unchanged</h1>")

    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${FilePaths.visualEdit}`, {
        method: "POST",
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
        body: JSON.stringify({
          modifiedHtml: "<h1>Changed</h1>",
          changes: [{ selector: "h1", type: "text", content: "Changed", sourcePath: "index.html" }],
          model: { providerID: "test", modelID: "test-model" },
        }),
      }),
      context,
    )

    const body = (await response.json()) as { success: boolean; filesWritten: string[]; error?: string }
    expect(body).toMatchObject({ success: false, filesWritten: [] })
    expect(body.error).toStartWith("test/test-model: ")
  })

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
