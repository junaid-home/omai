export interface VmPreviewTarget {
  readonly url: string
  readonly headers?: HeadersInit
}

const map = new Map<string, VmPreviewTarget>()

export function setVmPreviewTarget(workspaceID: string, target: VmPreviewTarget) {
  map.set(workspaceID, { ...target, url: target.url.replace(/\/+$/, "") })
}

export function getVmPreviewTarget(workspaceID: string): VmPreviewTarget | undefined {
  return map.get(workspaceID)
}
