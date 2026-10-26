/**
 * Structural workspace-adapter contract. Mirrors the OpenCode plugin-facing
 * `WorkspaceAdapter` shape so this package never imports OpenCode internals.
 * The control plane casts on registration; optional `start`/`stop`/`busy`
 * power lifecycle management when present.
 */
export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export type WorkspaceTarget =
  | { type: "local"; directory: string }
  | { type: "remote"; url: string | URL; headers?: Record<string, string> }

export type AdapterContext = {
  readonly instance?: { readonly directory: string }
  readonly workspaceID?: string
}

export type BusyReport = {
  busy: boolean
  reasons: string[]
}

/**
 * Thrown by an adapter's `target`/`start`/`stop` when the backing VM no longer
 * exists (a create failed after its row committed, or the service was deleted
 * out-of-band). The control plane treats it as "this workspace is gone" and
 * reconciles by dropping the row and re-provisioning, rather than latching a
 * permanent broken-sync 503 on a row that can never heal.
 */
export class WorkspaceGoneError extends Error {
  constructor(readonly workspaceID: string) {
    super(`MicroVM not found for workspace: ${workspaceID}`)
    this.name = "WorkspaceGoneError"
  }
}

export type WorkspaceAdapter = {
  name: string
  description: string
  configure(info: WorkspaceInfo, context?: AdapterContext): WorkspaceInfo | Promise<WorkspaceInfo>
  create(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(info: WorkspaceInfo, context?: AdapterContext): Promise<void>
  target(info: WorkspaceInfo, context?: AdapterContext): WorkspaceTarget | Promise<WorkspaceTarget>
  start?(info: WorkspaceInfo, context?: AdapterContext): Promise<void>
  stop?(info: WorkspaceInfo, context?: AdapterContext): Promise<void>
  busy?(info: WorkspaceInfo, context?: AdapterContext): Promise<BusyReport>
}
