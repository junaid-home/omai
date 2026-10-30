import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkspaceBusy } from "../../src/control-plane/workspace-busy"

const idle = { execution: { active: Effect.succeed(new Set<never>()) }, appProcess: { running: Effect.succeed(0) } }

describe("WorkspaceBusy", () => {
  test("report names what keeps the instance busy", async () => {
    expect(await Effect.runPromise(WorkspaceBusy.report({ ...idle, preview: false }))).toEqual({
      busy: false,
      reasons: [],
    })
    expect(
      await Effect.runPromise(
        WorkspaceBusy.report({ ...idle, appProcess: { running: Effect.succeed(2) }, preview: true }),
      ),
    ).toEqual({ busy: true, reasons: ["processes:2", "preview"] })
  })

  test("keeps the report a heartbeat carried, and ignores one from an older VM image", () => {
    const pushed = `wrk_${crypto.randomUUID()}`
    const older = `wrk_${crypto.randomUUID()}`

    WorkspaceBusy.record(pushed, { busy: true, reasons: ["sessions:1", 7] })
    WorkspaceBusy.record(older, {})

    expect(WorkspaceBusy.latest(pushed)).toEqual({ busy: true, reasons: ["sessions:1"] })
    expect(WorkspaceBusy.latest(older)).toBeUndefined()

    WorkspaceBusy.forget(pushed)
    expect(WorkspaceBusy.latest(pushed)).toBeUndefined()
  })
})
