import { createHmac } from "node:crypto"
import { Authentication } from "@opencode-ai/core/authentication"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { configFromEnv, northflankAdapter } from "@opencode-ai/northflank"
import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"
import { WorktreeAdapter } from "./worktree"

const BUILTIN: Record<string, WorkspaceAdapter> = {
  worktree: WorktreeAdapter,
  ...(process.env["NORTHFLANK_API_TOKEN"]
    ? { northflank: northflankAdapter(northflankConfig()) as WorkspaceAdapter }
    : {}),
}

// The control plane dials a workspace VM with a deployment credential and no
// user session (sync, history and replay originate there), so the VM
// authenticates those calls against the same value. Deriving it from the
// signing secret keeps it stable across restarts without new configuration;
// NORTHFLANK_VM_PASSWORD overrides it, and a deployment without a signing
// secret has no VM dial credential — VMs cannot serve without one.
function northflankConfig() {
  const config = configFromEnv(process.env)
  return { ...config, vmPassword: config.vmPassword ?? vmDialPassword() }
}

function vmDialPassword() {
  const secret = Authentication.secret("OPENCODE_JWT_SECRET")
  return secret ? createHmac("sha256", secret).update("workspace-vm-dial").digest("base64url") : undefined
}

const state = new Map<ProjectV2.ID, Map<string, WorkspaceAdapter>>()

export function getAdapter(projectID: ProjectV2.ID, type: string): WorkspaceAdapter {
  const custom = state.get(projectID)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN[type]
  if (builtin) return builtin

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export function listAdapters(projectID: ProjectV2.ID): WorkspaceAdapterEntry[] {
  return registeredAdapters(projectID).map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
}

export function registeredAdapters(projectID: ProjectV2.ID): [string, WorkspaceAdapter][] {
  const adapters = new Map(Object.entries(BUILTIN))
  for (const [type, adapter] of state.get(projectID)?.entries() ?? []) adapters.set(type, adapter)
  return [...adapters.entries()]
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectV2.ID.global`
export function registerAdapter(projectID: ProjectV2.ID, type: string, adapter: WorkspaceAdapter) {
  const adapters = state.get(projectID) ?? new Map<string, WorkspaceAdapter>()
  adapters.set(type, adapter)
  state.set(projectID, adapters)
}
