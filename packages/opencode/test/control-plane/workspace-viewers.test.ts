import { describe, expect, test } from "bun:test"
import { WorkspaceViewers } from "../../src/control-plane/workspace-viewers"

const delta = (workspace: string) => ({
  workspace,
  payload: { type: "message.part.delta", properties: { delta: "token" } },
})

const login = (userID = crypto.randomUUID()) => ({ sessionID: crypto.randomUUID(), userID })

// A workspace owned by a fresh user, as the sync loop records it.
const owned = (userID: string) => {
  const workspace = `wrk_${crypto.randomUUID()}`
  WorkspaceViewers.own(workspace, userID)
  return workspace
}

describe("WorkspaceViewers", () => {
  test("a tab gets streamed tokens only from VMs its login has used", () => {
    const tab = login()
    const own = owned(tab.userID)
    const other = owned(tab.userID)
    expect(WorkspaceViewers.relays(tab, delta(own))).toBe(false)

    WorkspaceViewers.view(tab.sessionID, own)

    expect(WorkspaceViewers.relays(tab, delta(own))).toBe(true)
    expect(WorkspaceViewers.relays(tab, delta(other))).toBe(false)
    expect(WorkspaceViewers.relays(login(tab.userID), delta(own))).toBe(false)
  })

  test("part updates follow the same rule as streamed tokens", () => {
    const tab = login()
    const workspace = owned(tab.userID)
    const updated = { workspace, payload: { type: "message.part.updated" } }
    const removed = { workspace, payload: { type: "message.part.removed" } }
    expect(WorkspaceViewers.relays(tab, updated)).toBe(false)
    expect(WorkspaceViewers.relays(tab, removed)).toBe(false)

    WorkspaceViewers.view(tab.sessionID, workspace)

    expect(WorkspaceViewers.relays(tab, updated)).toBe(true)
    expect(WorkspaceViewers.relays(tab, removed)).toBe(true)
  })

  test("signed-in tabs never get durable sync events, machine clients always do", () => {
    const tab = login()
    const workspace = owned(tab.userID)
    WorkspaceViewers.view(tab.sessionID, workspace)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "sync" } })).toBe(false)
    expect(WorkspaceViewers.relays(tab, { payload: { type: "sync" } })).toBe(false)
    expect(WorkspaceViewers.relays(undefined, { workspace, payload: { type: "sync" } })).toBe(true)
  })

  test("other events of a VM reach every tab of its owner", () => {
    const tab = login()
    const workspace = owned(tab.userID)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "session.status" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { workspace, payload: { type: "message.updated" } })).toBe(true)
    expect(WorkspaceViewers.relays(tab, { payload: { type: "message.part.delta" } })).toBe(true)
    expect(WorkspaceViewers.relays(undefined, delta(workspace))).toBe(true)
  })

  test("no event of another user's VM reaches a tab, even one that tried to view it", () => {
    const tab = login()
    const foreign = owned(crypto.randomUUID())
    WorkspaceViewers.view(tab.sessionID, foreign)
    expect(WorkspaceViewers.relays(tab, { workspace: foreign, payload: { type: "session.status" } })).toBe(false)
    expect(WorkspaceViewers.relays(tab, { workspace: foreign, payload: { type: "permission.asked" } })).toBe(false)
    expect(WorkspaceViewers.relays(tab, delta(foreign))).toBe(false)
  })

  test("events of a VM with no recorded owner reach no signed-in tab", () => {
    const workspace = `wrk_${crypto.randomUUID()}`
    expect(WorkspaceViewers.relays(login(), { workspace, payload: { type: "session.status" } })).toBe(false)
    expect(WorkspaceViewers.relays(undefined, { workspace, payload: { type: "session.status" } })).toBe(true)
  })
})
