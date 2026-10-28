export type NorthflankConfig = {
  /** Northflank API base, without a trailing slash. */
  apiBase: string
  token: string
  /** Northflank project the MicroVM services live in. */
  project: string
  image: string
  plan: string
  volumeSizeMB: number
  /** Port `opencode serve` listens on inside the container. */
  port: number
  /** Scheme used to reach a service's public DNS (http for local stubs). */
  scheme: "http" | "https"
  /** Basic-auth credentials the control plane uses when proxying to the VM. */
  vmUsername: string
  vmPassword?: string
  /** Global opencode config (JSON/JSONC) every VM writes to ~/.config/opencode/opencode.jsonc on boot. */
  vmGlobalConfig?: string
}

export function configFromEnv(env: Record<string, string | undefined>): NorthflankConfig {
  return {
    apiBase: env.NORTHFLANK_API_BASE ?? "https://api.northflank.com/v1",
    token: env.NORTHFLANK_API_TOKEN ?? "",
    project: env.NORTHFLANK_PROJECT_ID ?? env.NORTHFLANK_PROJECT ?? "omai",
    image: env.NORTHFLANK_IMAGE ?? "jj123dev/omaiflank",
    plan: env.NORTHFLANK_DEPLOYMENT_PLAN ?? "nf-compute-100-4",
    volumeSizeMB: Number(env.NORTHFLANK_VOLUME_SIZE_GB ?? 10) * 1024,
    port: Number(env.NORTHFLANK_SERVICE_PORT ?? 4096),
    scheme: env.NORTHFLANK_SERVICE_SCHEME === "http" ? "http" : "https",
    vmUsername: env.NORTHFLANK_VM_USERNAME ?? env.OPENCODE_SERVER_USERNAME ?? "omai",
    vmPassword: env.NORTHFLANK_VM_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD,
    vmGlobalConfig: env.NORTHFLANK_VM_GLOBAL_CONFIG,
  }
}
