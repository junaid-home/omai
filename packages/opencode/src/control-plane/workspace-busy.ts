import { AppProcess } from "@opencode-ai/core/process"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Effect } from "effect"
import { SessionStatus } from "@/session/status"

export type Report = { readonly busy: boolean; readonly reasons: readonly string[] }

/**
 * What keeps this instance from being suspended. A VM answers it on its busy
 * endpoint and pushes it on every event-stream heartbeat.
 */
export const report = Effect.fnUntraced(function* (input: {
  readonly execution: Pick<SessionExecution.Interface, "active">
  readonly appProcess: Pick<AppProcess.Interface, "running">
  readonly preview: boolean
}) {
  const reasons: string[] = []
  // The app's agent loop tracks its turns in SessionStatus, not V2 execution.
  const sessions = new Set([...(yield* input.execution.active), ...SessionStatus.busySessions()])
  if (sessions.size > 0) reasons.push(`sessions:${sessions.size}`)
  const running = yield* input.appProcess.running
  if (running > 0) reasons.push(`processes:${running}`)
  if (input.preview) reasons.push("preview")
  return { busy: reasons.length > 0, reasons } satisfies Report
})

// VMs heartbeat every 10s; a report older than a few missed beats means the
// stream stalled, and the control plane falls back to asking the VM directly.
const FRESH_MS = 30_000
const pushed = new Map<string, Report & { readonly at: number }>()

/** Control plane: keep the report a VM pushed on its heartbeat, if it sent one. */
export function record(workspaceID: string, properties: unknown) {
  if (!properties || typeof properties !== "object" || !("busy" in properties)) return
  const reasons = "reasons" in properties && Array.isArray(properties.reasons) ? properties.reasons : []
  pushed.set(workspaceID, {
    busy: properties.busy === true,
    reasons: reasons.filter((reason): reason is string => typeof reason === "string"),
    at: Date.now(),
  })
}

/** The VM's last pushed report, or undefined when none arrived recently (e.g. an older VM image). */
export function latest(workspaceID: string): Report | undefined {
  const hit = pushed.get(workspaceID)
  if (!hit || Date.now() - hit.at >= FRESH_MS) return undefined
  return { busy: hit.busy, reasons: hit.reasons }
}

export function forget(workspaceID: string) {
  pushed.delete(workspaceID)
}

export * as WorkspaceBusy from "./workspace-busy"
