import path from "node:path"
import { CentralStorage } from "@opencode-ai/core/storage/central"

/** Apply the assigned request workspace to body-supplied directories too. */
export async function resolve(workspace: string, directory: string, input = ".", allowRoot = false) {
  const base = await CentralStorage.resolveUnder(workspace, path.resolve(directory))
  const target = path.resolve(base, input)
  const canonical = await CentralStorage.resolveUnder(base, target)
  if (!allowRoot && canonical === workspace) {
    throw new CentralStorage.StorageError("outside_root", "The workspace root cannot be modified as a file")
  }
  return target
}

export * as WorkspaceFile from "./workspace-file"
