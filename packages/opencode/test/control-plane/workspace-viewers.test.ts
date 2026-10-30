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

  test("part updates follow the same rule as streamed tokens", () => {
    const tab = crypto.randomUUID()
    const workspace = `wrk_${crypto.randomUUID()}`
    const updated = { workspace, payload: { type: "message.part.updated" } }
    const removed = { workspace, payload: { type: "message.part.removed" } }
    expect(WorkspaceViewers.relays(tab, updated)).toBe(false)
    expect(WorkspaceViewers.relays(tab, removed)).toBe(false)

    WorkspaceViewers.view(tab, workspace)

    expect(WorkspaceViewers.relays(tab, updated)).toBe(true)
    expect(WorkspaceViewers.relays(tab, removed)).toBe(true)
  })

  test("signed-in tabs never get durable sync events, machine clients always do", () => {
    const tab = crypto.randomUUID()
    const workspace = `wrk_${crypto.randomUUID()}`
    WorkspaceViewers.view(tab, workspace)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "sync" } })).toBe(false)
    expect(WorkspaceViewers.relays(tab, { payload: { type: "sync" } })).toBe(false)
    expect(WorkspaceViewers.relays(undefined, { workspace, payload: { type: "sync" } })).toBe(true)
  })

  test("everything else reaches every tab", () => {
    const tab = crypto.randomUUID()
    const workspace = `wrk_${crypto.randomUUID()}`
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "session.status" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "message.updated" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { payload: { type: "message.part.delta" } })).toBe(true)
    expect(WorkspaceViewers.relays(undefined, delta(workspace))).toBe(true)
  })
})
