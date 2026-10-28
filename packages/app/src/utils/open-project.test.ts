import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { openProjectImmediate, projectHref } from "./open-project"

const session = (id: string, updated: number) => ({ id, time: { created: updated, updated } }) as Session
const href = (id: string) => `/server/s/session/${id}`
const fast = { attempts: 5, delayMs: 1 }

describe("openProjectImmediate", () => {
  test("opens the newest session", async () => {
    const seen: string[] = []
    await openProjectImmediate(
      "/p",
      (to) => seen.push(to),
      href,
      async () => ({ data: [session("old", 1), session("new", 2)] }),
      async () => ({ data: session("created", 3) }),
      fast,
    )
    expect(seen).toEqual(["/server/s/session/new"])
  })

  test("creates a session when the project has none", async () => {
    const seen: string[] = []
    await openProjectImmediate(
      "/p",
      (to) => seen.push(to),
      href,
      async () => ({ data: [] }),
      async () => ({ data: session("created", 3) }),
      fast,
    )
    expect(seen).toEqual(["/server/s/session/created"])
  })

  test("keeps retrying while the VM wakes instead of treating an error as no sessions", async () => {
    const seen: string[] = []
    let listCalls = 0
    let created = 0
    await openProjectImmediate(
      "/p",
      (to) => seen.push(to),
      href,
      async () => {
        listCalls += 1
        // A waking VM answers with an error (e.g. 503 workspace_provisioning).
        if (listCalls < 3) return { error: { code: "workspace_provisioning" } }
        return { data: [session("existing", 1)] }
      },
      async () => {
        created += 1
        return { data: session("created", 3) }
      },
      fast,
    )
    expect(seen).toEqual(["/server/s/session/existing"])
    expect(created).toBe(0)
  })

  test("retries a failed create and only falls back after every attempt failed", async () => {
    const seen: string[] = []
    await openProjectImmediate(
      "/p",
      (to) => seen.push(to),
      href,
      async () => {
        throw new Error("offline")
      },
      async () => ({ error: {} }),
      fast,
    )
    expect(seen).toEqual([projectHref("/p")])
  })
})
