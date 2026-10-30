import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys, sessionProject } from "./layout-helpers"
import { ServerScope, SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("sessionProject", () => {
  // Panels are stored per project: each session of one project shares them,
  // and another project's sessions never see them.
  test("every session view of a project resolves to that project, in both key forms", () => {
    const scoped = (dir: string, id?: string) =>
      sessionProject(SessionStateKey.from(ServerScope.local, SessionRouteKey.fromRoute(dir, id)))

    expect(scoped("L2hvbWUvYQ", "ses_1")).toBe("L2hvbWUvYQ")
    expect(scoped("L2hvbWUvYQ", "ses_2")).toBe("L2hvbWUvYQ")
    expect(scoped("L2hvbWUvYQ")).toBe("L2hvbWUvYQ")
    expect(sessionProject("L2hvbWUvYQ/ses_1")).toBe("L2hvbWUvYQ")
    expect(scoped("L2hvbWUvYg", "ses_1")).not.toBe(scoped("L2hvbWUvYQ", "ses_1"))
  })
})
