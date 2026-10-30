import { describe, expect, test } from "bun:test"
import { WorkspaceViewers } from "../../src/control-plane/workspace-viewers"

const delta = (workspace: string) => ({
  workspace,
  payload: { type: "message.part.delta", properties: { delta: "token" } },
})

describe("WorkspaceViewers", () => {
  test("a tab gets streamed tokens only from VMs its login has used", () => {
    const tab = crypto.randomUUID()
    const own = `wrk_own_${crypto.randomUUID()}`
    const other = `wrk_other_${crypto.randomUUID()}`
    expect(WorkspaceViewers.relays(tab, delta(own))).toBe(false)

    WorkspaceViewers.view(tab, own)

    expect(WorkspaceViewers.relays(tab, delta(own))).toBe(true)
    expect(WorkspaceViewers.relays(tab, delta(other))).toBe(false)
    expect(WorkspaceViewers.relays(crypto.randomUUID(), delta(own))).toBe(false)
  })

  test("everything else reaches every tab", () => {
    const tab = crypto.randomUUID()
    const workspace = `wrk_${crypto.randomUUID()}`
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "session.status" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "sync" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { payload: { type: "message.part.delta" } })).toBe(true)
    expect(WorkspaceViewers.relays(undefined, delta(workspace))).toBe(true)
  })
})
