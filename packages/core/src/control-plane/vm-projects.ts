import { Flag } from "../flag/flag"

export function vmProjectsRoot() {
  if (!Flag.OPENCODE_WORKSPACE_ADAPTER) return undefined
  return Flag.OPENCODE_VM_PROJECTS_ROOT ?? "/home/runner"
}

export * as VmProjects from "./vm-projects"
