import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { openProjectImmediate, prefetchProjectSessions } from "./open-project"

const session = (id: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  time: { created: 1, updated },
})

describe("openProjectImmediate", () => {
  test("resumes the most recent session and navigates straight to the canonical server URL", async () => {
    const hrefs: string[] = []
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({ data: [session("older", 10), session("newest", 20)] }),
      async () => ({ data: session("created", 30) }),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/newest"])
  })

  test("skips archived sessions", async () => {
    const hrefs: string[] = []
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({
        data: [{ ...session("archived", 50), time: { created: 1, updated: 50, archived: 60 } }, session("active", 10)],
      }),
      async () => ({ data: session("created", 30) }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/active"])
  })

  test("creates a session when there are no sessions", async () => {
    const hrefs: string[] = []
    let created = false
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({ data: [] }),
      async () => {
        created = true
        return { data: session("created", 30) }
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(created).toBe(true)
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/created"])
  })

  test("falls back to the bare project route when a created session fails", async () => {
    const hrefs: string[] = []
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({
        data: [] as Session[],
      }),
      async () => {
        throw new Error("create failed")
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual([`/${base64Encode("/repo")}/session`])
  })

  test("falls back to the bare project route when listing fails", async () => {
    const hrefs: string[] = []
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => {
        throw new Error("list failed")
      },
      async () => ({ data: session("created", 30) }),
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual([`/${base64Encode("/repo")}/session`])
  })

  test("falls back to the bare project route when no session is resolved", async () => {
    const hrefs: string[] = []
    openProjectImmediate(
      "/repo",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({ data: [] }),
      async () => ({ data: undefined }),
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual([`/${base64Encode("/repo")}/session`])
  })
})

describe("prefetchProjectSessions", () => {
  test("reuses a prefetched session list without fetching again", async () => {
    const hrefs: string[] = []
    let listCalls = 0
    await prefetchProjectSessions("/prefetch-hit", async () => ({ data: [session("cached", 10)] }))
    openProjectImmediate(
      "/prefetch-hit",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => {
        listCalls++
        return { data: [session("fresh", 99)] }
      },
      async () => ({ data: session("created", 30) }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(listCalls).toBe(0)
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/cached"])
  })

  test("evicts the cached list when the prefetch fails so the click retries", async () => {
    const hrefs: string[] = []
    await prefetchProjectSessions("/prefetch-fail", async () => {
      throw new Error("prefetch failed")
    }).catch(() => {})
    openProjectImmediate(
      "/prefetch-fail",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({ data: [session("fresh", 5)] }),
      async () => ({ data: session("created", 30) }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/fresh"])
  })

  test("creates a session during prefetch so the click does not create one", async () => {
    const hrefs: string[] = []
    let created = 0
    await prefetchProjectSessions(
      "/prefetch-empty",
      async () => ({ data: [] as Session[] }),
      async () => {
        created++
        return { data: session("prefetched-created", 40) }
      },
    )
    openProjectImmediate(
      "/prefetch-empty",
      (href) => hrefs.push(href),
      (id) => `/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/${id}`,
      async () => ({ data: [session("should-not-be-used", 99)] }),
      async () => {
        throw new Error("click must not create")
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(created).toBe(1)
    expect(hrefs).toEqual(["/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/prefetched-created"])
  })

  test("keeps an existing session during prefetch without creating", async () => {
    let created = 0
    const result = await prefetchProjectSessions(
      "/prefetch-existing",
      async () => ({ data: [session("existing", 10)] }),
      async () => {
        created++
        return { data: session("extra", 20) }
      },
    )
    expect(created).toBe(0)
    expect(result.data?.map((item) => item.id)).toEqual(["existing"])
  })
})
