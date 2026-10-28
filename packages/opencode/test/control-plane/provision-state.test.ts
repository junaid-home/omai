import { describe, expect, test } from "bun:test"
import { ProvisionState } from "../../src/control-plane/provision-state"

const t = 1_000_000
const fresh = () => ProvisionState.begin({ kind: "new", mode: "empty", now: t, bootDeadlineMs: 120_000 })

describe("control-plane provision state", () => {
  test("rows without a valid provision read as legacy", () => {
    expect(ProvisionState.read(null)).toBeUndefined()
    expect(ProvisionState.read({ provision: { status: "bogus" } })).toBeUndefined()
  })

  test("write round-trips and keeps other extra keys", () => {
    const state = fresh()
    const extra = ProvisionState.write({ other: 1 }, state)
    expect(extra.other).toBe(1)
    expect(ProvisionState.read(extra)).toEqual(state)
  })

  test("begin starts running at creating with the boot deadline", () => {
    expect(fresh()).toMatchObject({ status: "running", step: "creating", cleaned: false, deadline: t + 120_000 })
  })

  test("advance records time spent in the previous step", () => {
    expect(ProvisionState.advance(fresh(), "booting", t + 10, 1_800_000).timings.creating).toBe(10)
  })

  test("advancing to upload extends the deadline to the upload budget", () => {
    expect(ProvisionState.advance(fresh(), "upload", t, 1_800_000).deadline).toBe(t + 1_800_000)
  })

  test("advancing to done makes the job ready", () => {
    expect(ProvisionState.advance(fresh(), "done", t, 1_800_000).status).toBe("ready")
  })

  test("fail and cleaned", () => {
    const failed = ProvisionState.fail(fresh(), "boom", t + 5)
    expect(failed).toMatchObject({ status: "failed", error: "boom", cleaned: false, updatedAt: t + 5 })
    expect(ProvisionState.cleaned(failed, t + 6).cleaned).toBe(true)
  })

  test("only ready, legacy, or awaiting-upload workspaces are proxyable", () => {
    expect(ProvisionState.proxyable(undefined)).toBe(true)
    expect(ProvisionState.proxyable(ProvisionState.advance(fresh(), "done", t, 1))).toBe(true)
    expect(ProvisionState.proxyable(ProvisionState.advance(fresh(), "upload", t, 1))).toBe(true)
    expect(ProvisionState.proxyable(ProvisionState.advance(fresh(), "booting", t, 1))).toBe(false)
    expect(ProvisionState.proxyable(ProvisionState.fail(fresh(), "x", t))).toBe(false)
  })
})
