export * as ConfigNames from "./names"

import path from "path"
import fs from "fs"

/** Config document names owned by OMAI, searched with priority over the legacy ones. */
export const documents = ["omai.json", "omai.jsonc"]

/** Pre-OMAI config document names, still read so existing installs keep working. */
export const legacyDocuments = ["opencode.json", "opencode.jsonc"]

/** Search order for config documents: legacy first so OMAI-named files win a merge. */
export const allDocuments = [...legacyDocuments, ...documents]

/** Per-project config directory: `.omai`, with `.opencode` kept for legacy setups. */
export const directories = [".omai", ".opencode"]

/** JSON schema served by the OMAI deployment, injected into config for editor completion. */
export const schema = "https://omai.ch/config.json"

export function isDirectory(directory: string) {
  return directories.includes(path.basename(directory))
}

/**
 * Directory to write new OMAI config files into. An existing `.opencode` directory
 * keeps being used so files created before the rename stay discoverable.
 */
export function targetDirectory(root: string) {
  const legacy = path.join(root, ".opencode")
  const current = path.join(root, ".omai")
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current
}