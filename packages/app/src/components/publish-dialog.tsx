import { createEffect, Show, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"

interface Deployment {
  id: string
  name: string
  label: string
  url: string
  status: string
  runtime?: string
  created_at: number
}

const errorMessage = (err: { message?: string; data?: { message?: string } } | null | undefined) =>
  err?.data?.message || err?.message || ""

interface CustomDomain {
  domain: string
  status: string
  cname_target: string
  nameservers?: string[]
}

export function PublishDialog() {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    deploying: false,
    deployStatus: "",
    error: null as string | null,
    existing: null as Deployment | null,
    loaded: false,
    copied: false,
    customDomainInput: "",
    domainTouched: false,
    addingDomain: false,
    domainError: null as string | null,
    customDomains: [] as CustomDomain[],
    removingDomain: null as string | null,
    checkingDns: false,
    loadingDomains: true,
    zoneSetup: null as { name_servers: string[]; name: string } | null,
    settingUpZone: false,
    zoneError: null as string | null,
    checkingNameservers: false,
    dnsVerification: null as {
      cname_ok: boolean
      nameservers_ok: boolean
      cname_target: string
      expected_nameservers: string[]
      status: string
    } | null,
  })

  const [snapshot, setSnapshot, , snapshotReady] = persisted(
    Persist.serverWorkspace(sdk().scope, sdk().directory, "publish-deployment", ["publish-deployment.v1"]),
    createStore({
      existing: null as Deployment | null,
      customDomains: [] as CustomDomain[],
    }),
  )

  const hydrateSnapshot = () => {
    if (!snapshot.existing) return
    setState("existing", snapshot.existing)
    setState("customDomains", snapshot.customDomains)
    setState("loaded", true)
  }
  hydrateSnapshot()
  snapshotReady.promise?.then(hydrateSnapshot)

  createEffect(() => {
    setSnapshot({ existing: state.existing, customDomains: state.customDomains })
  })

  const loadExisting = async () => {
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
      if (response.ok) {
        const result = await response.json()
        const rows = Array.isArray(result) ? result : []
        // Prefer the server row when present, but keep the persisted snapshot otherwise:
        // a deployment may be live on Cloudflare even if its database row was lost.
        if (rows.length > 0) setState("existing", rows[0])
      }
    } catch (err) {
      console.error("Failed to load deployment:", err)
    } finally {
      setState("loaded", true)
    }
  }

  const loadCustomDomains = async () => {
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/domain?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
      if (response.ok) {
        const result = await response.json()
        setState("customDomains", Array.isArray(result) ? result : [])
      }
    } catch (err) {
      console.error("Failed to load custom domains:", err)
    } finally {
      setState("loadingDomains", false)
    }
  }

  createEffect(() => {
    loadExisting()
  })

  createEffect(() => {
    if (state.existing) {
      setState("loadingDomains", true)
      loadCustomDomains()
    }
  })

  const handleDeploy = async () => {
    setState({ deploying: true, deployStatus: language.t("publish.deploy.building"), error: null })
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: sdk().directory }),
      })
      if (response.ok) {
        const result = await response.json()
        setState("existing", {
          id: result.id,
          name: result.name,
          label: result.name,
          url: result.url,
          status: result.status,
          runtime: result.runtime,
          created_at: Date.now(),
        })
        showToast({ title: language.t("publish.deploy.toast", { url: result.url }) })
        setState("deployStatus", "")
      } else {
        const err = await response.json()
        setState({ error: errorMessage(err) || language.t("publish.deploy.failed"), deployStatus: "" })
      }
    } catch (err: unknown) {
      setState({ error: err instanceof Error ? err.message : language.t("publish.deploy.failed"), deployStatus: "" })
    } finally {
      setState("deploying", false)
    }
  }

  const handleRedeploy = async () => {
    const dep = state.existing
    if (!dep) return
    setState({ deploying: true, deployStatus: language.t("publish.deploy.building"), error: null })
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/redeploy?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: dep.id, directory: sdk().directory, name: dep.name, runtime: dep.runtime }),
      })
      if (response.ok) {
        const result = await response.json()
        setState("existing", { ...dep, url: result.url, status: result.status, runtime: result.runtime })
        showToast({ title: language.t("publish.redeploy.toast", { url: result.url }) })
        setState("deployStatus", "")
      } else {
        const err = await response.json()
        setState({ error: errorMessage(err) || language.t("publish.deploy.failed"), deployStatus: "" })
      }
    } catch (err: unknown) {
      setState({ error: err instanceof Error ? err.message : language.t("publish.deploy.failed"), deployStatus: "" })
    } finally {
      setState("deploying", false)
    }
  }

  const handleDelete = () => {
    const dep = state.existing
    if (!dep) return

    dialog.show(
      () => (
        <Dialog size="normal" title={language.t("publish.delete.title")} fit>
          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
            <div class="flex flex-col gap-1">
              <span class="text-14-regular text-text-strong">{language.t("publish.delete.confirm")}</span>
              <span class="text-13-regular text-text-muted leading-relaxed">{language.t("publish.delete.hint")}</span>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
                onClick={async () => {
                  dialog.close()
                  try {
                    const response = await fetch(`${sdk().url}/publish/delete`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: dep.id }),
                    })
                    if (response.ok) {
                      showToast({ title: language.t("publish.delete.toast") })
                      setState("existing", null)
                      setState("customDomains", [])
                    } else {
                      const err = await response.json()
                      showToast({ variant: "error", title: errorMessage(err) || language.t("publish.delete.failed") })
                    }
                  } catch (err: unknown) {
                    showToast({
                      variant: "error",
                      title: err instanceof Error ? err.message : language.t("publish.delete.failed"),
                    })
                  }
                }}
              >
                {language.t("publish.delete.action")}
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {},
    )
  }

  const handleCopyUrl = async () => {
    const dep = state.existing
    if (!dep) return
    try {
      await navigator.clipboard.writeText(dep.url)
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    } catch {
      showToast({ variant: "error", title: language.t("publish.copyUrl.failed") })
    }
  }

  const handleAddDomain = async () => {
    const dep = state.existing
    const domain = state.customDomainInput.trim()
    if (!dep || !domain) return

    if (!isValidDomain(domain)) {
      setState("domainTouched", true)
      return
    }

    setState({ addingDomain: true, domainError: null, dnsVerification: null })
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/domain?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployment_id: dep.id, domain }),
      })
      if (response.ok) {
        const result = await response.json()
        setState("customDomains", [result])
        setState("customDomainInput", "")
        showToast({ title: language.t("publish.domain.added", { domain }) })
      } else {
        const err = await response.json()
        setState({ domainError: errorMessage(err) || language.t("publish.domain.add.failed") })
      }
    } catch (err: unknown) {
      setState({ domainError: err instanceof Error ? err.message : language.t("publish.domain.add.failed") })
    } finally {
      setState("addingDomain", false)
    }
  }

  const handleRemoveDomain = (domain: string) => {
    const dep = state.existing
    if (!dep) return

    dialog.show(
      () => (
        <Dialog size="normal" title={language.t("publish.domain.remove.title")} fit>
          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
            <div class="flex flex-col gap-1">
              <span class="text-14-regular text-text-strong">
                {language.t("publish.domain.remove.confirm", { domain })}
              </span>
              <span class="text-13-regular text-text-muted leading-relaxed">
                {language.t("publish.domain.remove.hint")}
              </span>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
                onClick={async () => {
                  dialog.close()
                  setState("removingDomain", domain)
                  try {
                    const params = new URLSearchParams({ directory: sdk().directory })
                    const response = await fetch(`${sdk().url}/publish/domain/remove?${params}`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ deployment_id: dep.id, domain }),
                    })
                    if (response.ok) {
                      setState("customDomains", [])
                      showToast({ title: language.t("publish.domain.removed", { domain }) })
                    } else {
                      const err = await response.json()
                      showToast({
                        variant: "error",
                        title: errorMessage(err) || language.t("publish.domain.remove.failed"),
                      })
                    }
                  } catch (err: unknown) {
                    showToast({
                      variant: "error",
                      title: err instanceof Error ? err.message : language.t("publish.domain.remove.failed"),
                    })
                  } finally {
                    setState("removingDomain", null)
                  }
                }}
              >
                {language.t("publish.domain.remove.action")}
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {},
    )
  }

  const handleCheckDns = async () => {
    const domain = state.customDomains[0]?.domain
    if (!domain) return
    setState("checkingDns", true)
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/domain/verify?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      })
      if (response.ok) {
        const result = await response.json()
        setState("dnsVerification", {
          cname_ok: result.cname_ok,
          nameservers_ok: result.nameservers_ok,
          cname_target: result.cname_target,
          expected_nameservers: result.expected_nameservers,
          status: result.status,
        })
        setState("customDomains", [{ ...state.customDomains[0], status: result.status }])
        if (result.status === "active") {
          setState("zoneSetup", null)
          showToast({ title: language.t("publish.domain.verify.connected") })
        } else {
          showToast({ title: language.t("publish.domain.verify.notReady") })
        }
      }
    } catch (err) {
      console.error("Failed to verify DNS:", err)
    } finally {
      setState("checkingDns", false)
    }
  }

  const isWorkersDeployment = () => {
    const r = state.existing?.runtime
    const url = state.existing?.url || ""
    return r === "workers" || (!url.endsWith(".pages.dev") && r !== "pages")
  }

  const isPlatformDeployment = () => state.existing?.runtime === "platform"

  const isValidDomain = (input: string) => {
    const domain = input.trim().toLowerCase()
    if (!domain) return false
    if (domain.includes("://") || domain.startsWith("http")) return false
    if (domain.length > 253) return false
    if (!domain.includes(".")) return false
    if (domain.endsWith(".")) return false
    const labels = domain.split(".")
    if (labels.length < 2) return false
    return labels.every((label) => {
      if (label.length === 0 || label.length > 63) return false
      if (label.startsWith("-") || label.endsWith("-")) return false
      return /^[a-z0-9-]+$/.test(label)
    })
  }

  const domainStatusDotColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
      case "pending":
      case "initializing":
        return "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]"
      default:
        return "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
    }
  }

  const domainStatusLabel = (status: string) => {
    switch (status) {
      case "active":
        return language.t("publish.domain.status.active")
      case "pending":
      case "initializing":
        return language.t("publish.domain.status.pending")
      default:
        return language.t("publish.domain.status.failed")
    }
  }

  const domainStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "text-green-600 dark:text-green-400"
      case "pending":
      case "initializing":
        return "text-amber-600 dark:text-amber-400"
      default:
        return "text-red-600 dark:text-red-400"
    }
  }

  const handleSetupZone = async (domain: string): Promise<boolean> => {
    setState({ settingUpZone: true, zoneError: null })
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/zone?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      })
      const result = await response.json()
      if (!response.ok) {
        setState({ zoneError: errorMessage(result) || result.error || language.t("publish.zone.failed") })
        return false
      }
      if (result.status === "initializing" || result.status === "pending") {
        setState("zoneSetup", { name_servers: result.name_servers, name: result.name })
        return false
      }
      return true
    } catch (err) {
      setState({ zoneError: err instanceof Error ? err.message : language.t("publish.zone.failed") })
      return false
    } finally {
      setState("settingUpZone", false)
    }
  }

  const handleCheckNameservers = async () => {
    const domain = state.customDomainInput.trim() || state.zoneSetup?.name
    if (!domain) return
    setState("checkingNameservers", true)
    try {
      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/zone?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      })
      const result = await response.json()
      if (response.ok && result.status === "active") {
        setState("zoneSetup", null)
        showToast({ title: language.t("publish.ns.verified") })
        await handleAddWorkerDomain()
      } else if (response.ok && (result.status === "initializing" || result.status === "pending")) {
        setState("zoneSetup", { name_servers: result.name_servers, name: result.name })
        showToast({ title: language.t("publish.ns.notReady") })
      }
    } catch (err) {
      console.error("Failed to check nameservers:", err)
    } finally {
      setState("checkingNameservers", false)
    }
  }

  const handleAddWorkerDomain = async () => {
    const dep = state.existing
    const domain = state.customDomainInput.trim()
    if (!dep || !domain) return

    if (!isValidDomain(domain)) {
      setState("domainTouched", true)
      return
    }

    setState({ addingDomain: true, domainError: null, zoneError: null, dnsVerification: null })
    try {
      const zoneReady = await handleSetupZone(domain)
      if (!zoneReady) {
        setState({ addingDomain: false })
        return
      }

      const params = new URLSearchParams({ directory: sdk().directory })
      const response = await fetch(`${sdk().url}/publish/domain?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployment_id: dep.id, domain }),
      })
      if (response.ok) {
        const result = await response.json()
        setState("customDomains", [result])
        setState("customDomainInput", "")
        showToast({ title: language.t("publish.domain.added", { domain }) })
      } else {
        const err = await response.json()
        setState({ domainError: errorMessage(err) || language.t("publish.domain.add.failed") })
      }
    } catch (err: unknown) {
      setState({ domainError: err instanceof Error ? err.message : language.t("publish.domain.add.failed") })
    } finally {
      setState({ addingDomain: false })
    }
  }

  return (
    <>
      <style>{`
        [data-component="dialog"]:has(.publish-dialog) > [data-slot="dialog-container"] {
          height: auto;
          max-height: min(calc(85vh / var(--browser-zoom, 1)), 800px) !important;
        }
      `}</style>
      <Dialog title={language.t("publish.title")} size="normal" fit class="publish-dialog">
        <div class="flex flex-col gap-4 overflow-auto px-5 pb-5">
          {/* Pre-deploy state */}
          <Show when={state.loaded && !state.existing}>
            <div class="flex flex-col gap-4">
              <p class="text-13-regular text-text-muted text-center leading-relaxed">
                {language.t("publish.deploy.description")}
              </p>

              <Show when={state.error}>
                <div
                  class="rounded-lg border px-3.5 py-2.5 text-13-regular"
                  style={{
                    "border-color": "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 25%, transparent)",
                    background: "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 6%, transparent)",
                    color: "var(--text-on-critical-base, #ef4444)",
                  }}
                >
                  {state.error}
                </div>
              </Show>

              <Button variant="primary" size="large" disabled={state.deploying} onClick={handleDeploy} class="w-full">
                <span class="flex items-center justify-center gap-2">
                  <Show when={state.deploying} fallback={<Icon name="cloud-upload" size="small" />}>
                    <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  </Show>
                  {state.deploying
                    ? state.deployStatus || language.t("publish.deploy.deploying")
                    : language.t("publish.deploy.action")}
                </span>
              </Button>
            </div>
          </Show>

          {/* Post-deploy state */}
          <Show when={state.loaded && state.existing}>
            <div class="flex flex-col gap-4">
              {/* Live status hero */}
              <div
                class="relative overflow-hidden rounded-xl border border-green-200/60 dark:border-green-800/40 p-4"
                style={{
                  "background-image":
                    "radial-gradient(circle, color-mix(in srgb, #22c55e 15%, transparent) 0.6px, transparent 0.6px)",
                  "background-size": "20px 20px",
                  "background-color": "color-mix(in srgb, #22c55e 4%, var(--surface-raised-stronger-non-alpha, #fff))",
                }}
              >
                <div class="absolute inset-0 pointer-events-none">
                  <div
                    class="absolute -top-8 -right-8 h-32 w-32 rounded-full blur-3xl"
                    style={{ background: "radial-gradient(circle, rgba(34,197,94,0.2), transparent 70%)" }}
                  />
                </div>
                <div class="relative flex items-center gap-3">
                  <div class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                    <span class="absolute inset-0 animate-ping rounded-full bg-green-400/20" />
                    <Icon name="check" size="small" class="relative text-green-600 dark:text-green-400" />
                  </div>
                  <div class="flex flex-col gap-0.5 min-w-0">
                    <span class="text-14-medium text-text-strong leading-tight">
                      {language.t("publish.live.title")}
                    </span>
                    <span class="text-12-regular text-green-600/70 dark:text-green-400/60">
                      {isWorkersDeployment() || isPlatformDeployment()
                        ? language.t("publish.live.runtime.workers")
                        : language.t("publish.live.runtime.pages")}
                    </span>
                  </div>
                </div>
              </div>

              {/* URL bar */}
              <div
                class="flex items-center gap-2 rounded-lg px-3 py-2 transition-colors"
                style={{
                  background: "var(--surface-inset-base, #f5f5f5)",
                  "box-shadow": "inset 0 1px 2px rgba(0,0,0,0.06)",
                }}
              >
                <Icon name="link" size="small" class="shrink-0 text-icon-weak" />
                <a
                  href={state.existing?.url}
                  target="_blank"
                  class="min-w-0 flex-1 truncate text-13-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {state.existing?.url}
                </a>
                <button
                  type="button"
                  class="shrink-0 rounded-md p-1 text-icon-muted transition-colors hover:bg-white/60 hover:text-icon-strong dark:hover:bg-white/10 cursor-pointer"
                  onClick={handleCopyUrl}
                  title={language.t("publish.copyUrl.title")}
                >
                  <Show when={state.copied} fallback={<Icon name="copy" size="small" />}>
                    <Icon name="check" size="small" class="text-green-500" />
                  </Show>
                </button>
              </div>

              {/* Error */}
              <Show when={state.error}>
                <div
                  class="rounded-lg border px-3.5 py-2.5 text-13-regular"
                  style={{
                    "border-color": "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 25%, transparent)",
                    background: "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 6%, transparent)",
                    color: "var(--text-on-critical-base, #ef4444)",
                  }}
                >
                  {state.error}
                </div>
              </Show>

              {/* Custom domain section - Pages */}
              <Show when={isPlatformDeployment() || !isWorkersDeployment()}>
                <div class="flex flex-col gap-3">
                  <div
                    class="h-px w-full"
                    style={{ background: "linear-gradient(90deg, var(--border-base, rgba(0,0,0,0.08)), transparent)" }}
                  />
                  <div class="flex items-center gap-2">
                    <Icon name="link" size="small" class="text-icon-muted" />
                    <span class="text-13-medium text-text-strong">{language.t("publish.domain.title")}</span>
                  </div>

                  <Show when={state.loadingDomains}>
                    <div class="flex flex-col gap-2.5">
                      <div
                        class="h-9 w-full animate-pulse rounded-lg"
                        style={{
                          background: "color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.08)) 40%, transparent)",
                        }}
                      />
                      <div
                        class="h-3 w-3/4 animate-pulse rounded"
                        style={{
                          background: "color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.08)) 40%, transparent)",
                        }}
                      />
                    </div>
                  </Show>

                  <Show when={!state.loadingDomains && state.customDomains.length > 0}>
                    <For each={state.customDomains}>
                      {(domain) => (
                        <div class="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-muted/50 p-3.5">
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2.5">
                              <span class={`h-2 w-2 rounded-full ${domainStatusDotColor(domain.status)}`} />
                              <span class="text-13-medium text-text-strong">{domain.domain}</span>
                            </div>
                            <span class={`text-12-medium ${domainStatusColor(domain.status)}`}>
                              {domainStatusLabel(domain.status)}
                            </span>
                          </div>

                          <Show when={domain.status !== "active"}>
                            <div
                              class="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
                              style={{
                                "background-image":
                                  "radial-gradient(circle, color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.1)) 40%, transparent) 0.4px, transparent 0.4px)",
                                "background-size": "12px 12px",
                                "background-color": "var(--surface-inset-base, #fafafa)",
                              }}
                            >
                              <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                {language.t("publish.dns.record.title")}
                              </span>
                              <div class="flex flex-col gap-1.5 font-mono text-12-regular">
                                <div class="flex gap-2">
                                  <span class="text-text-muted w-12 shrink-0">
                                    {language.t("publish.dns.record.type")}
                                  </span>
                                  <span class="text-text-base font-medium">CNAME</span>
                                </div>
                                <div class="flex gap-2">
                                  <span class="text-text-muted w-12 shrink-0">
                                    {language.t("publish.dns.record.name")}
                                  </span>
                                  <span class="text-text-base break-all">{domain.domain}</span>
                                </div>
                                <div class="flex gap-2">
                                  <span class="text-text-muted w-12 shrink-0">
                                    {language.t("publish.dns.record.value")}
                                  </span>
                                  <span class="text-text-base break-all">{domain.cname_target}</span>
                                </div>
                              </div>
                              <p class="text-11-regular text-text-muted leading-relaxed mt-1">
                                {language.t("publish.dns.record.hint")}
                              </p>
                              <div class="flex flex-col gap-1.5 mt-2 pt-2 border-t border-border-subtle">
                                <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                  {language.t("publish.dns.help.cname")}
                                </span>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                                  <a
                                    href="https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    {language.t("publish.dns.help.cname.link")}
                                  </a>
                                  <a
                                    href="https://www.youtube.com/watch?v=TOqJtNQzHuM"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    {language.t("publish.dns.help.video")}
                                  </a>
                                </div>
                                <span class="text-11-medium text-text-muted mt-1">
                                  {language.t("publish.dns.help.guides")}
                                </span>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                                  <a
                                    href="https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    Namecheap
                                  </a>
                                  <a
                                    href="https://www.godaddy.com/en-in/help/add-a-cname-record-19236"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    GoDaddy
                                  </a>
                                  <a
                                    href="https://knowledge.workspace.google.com/admin/domains/add-a-cname-record-to-your-domains-dns-records"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    Google Domains
                                  </a>
                                </div>
                              </div>
                            </div>
                          </Show>

                          {/* DNS Verification Details - Pages */}
                          <Show when={state.dnsVerification}>
                            <div
                              class="flex flex-col gap-2 rounded-lg border p-3"
                              style={{
                                "border-color": state.dnsVerification?.cname_ok
                                  ? "color-mix(in srgb, #22c55e 30%, transparent)"
                                  : "color-mix(in srgb, #ef4444 30%, transparent)",
                                background: state.dnsVerification?.cname_ok
                                  ? "color-mix(in srgb, #22c55e 6%, var(--surface-inset-base, #fafafa))"
                                  : "color-mix(in srgb, #ef4444 6%, var(--surface-inset-base, #fafafa))",
                              }}
                            >
                              <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                {language.t("publish.dns.verification")}
                              </span>
                              <div class="flex flex-col gap-1.5">
                                <div class="flex items-center gap-2">
                                  <span
                                    class={`h-2 w-2 rounded-full ${state.dnsVerification?.cname_ok ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"}`}
                                  />
                                  <span
                                    class={`text-12-regular ${state.dnsVerification?.cname_ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                                  >
                                    {state.dnsVerification?.cname_ok
                                      ? language.t("publish.dns.cname.ok")
                                      : language.t("publish.dns.cname.fail")}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </Show>

                          <div class="flex items-center justify-between">
                            <Show when={domain.status !== "active"}>
                              <button
                                type="button"
                                disabled={state.checkingDns}
                                onClick={handleCheckDns}
                                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40 cursor-pointer disabled:opacity-50"
                              >
                                <Show
                                  when={!state.checkingDns}
                                  fallback={
                                    <span class="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600 dark:border-blue-700 dark:border-t-blue-400" />
                                  }
                                >
                                  <Icon name="refresh" size="small" />
                                </Show>
                                {state.checkingDns
                                  ? language.t("publish.dns.checking")
                                  : language.t("publish.dns.check")}
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="flex items-center gap-1.5 rounded-md px-2 py-1 text-12-regular text-text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer disabled:opacity-50 ml-auto"
                              disabled={state.removingDomain === domain.domain}
                              onClick={() => handleRemoveDomain(domain.domain)}
                            >
                              <Icon name="trash" size="small" />
                              {state.removingDomain === domain.domain
                                ? language.t("publish.domain.remove.removing")
                                : language.t("publish.domain.remove.action")}
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>

                  <Show when={!state.loadingDomains && state.customDomains.length === 0}>
                    <div class="flex flex-col gap-2.5">
                      <div class="flex gap-2">
                        <input
                          type="text"
                          value={state.customDomainInput}
                          onInput={(e) => {
                            setState("customDomainInput", e.currentTarget.value)
                            setState("domainTouched", false)
                          }}
                          placeholder="app.example.com"
                          class={`flex-1 rounded-lg border bg-bg-primary px-3 py-2 text-13-regular text-text-strong placeholder:text-text-muted transition-colors focus:outline-none focus:ring-2 ${
                            state.domainTouched && !isValidDomain(state.customDomainInput)
                              ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
                              : "border-border-subtle focus:border-blue-500 focus:ring-blue-500/20"
                          }`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && isValidDomain(state.customDomainInput)) handleAddDomain()
                          }}
                        />
                        <Button
                          onClick={handleAddDomain}
                          disabled={state.addingDomain || !isValidDomain(state.customDomainInput)}
                          variant="primary"
                          size="small"
                        >
                          {state.addingDomain ? (
                            <span class="flex items-center gap-1.5">
                              <span class="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              {language.t("publish.domain.adding")}
                            </span>
                          ) : (
                            language.t("publish.domain.add")
                          )}
                        </Button>
                      </div>
                      <p class="text-11-regular text-text-muted leading-relaxed">
                        {language.t("publish.domain.add.hint.prefix")}{" "}
                        <code class="rounded bg-bg-muted px-1 py-0.5 text-text-base font-[--font-family-mono] text-[11px]">
                          app.example.com
                        </code>{" "}
                        {language.t("publish.domain.add.hint.suffix")}{" "}
                        <code class="rounded bg-bg-muted px-1 py-0.5 text-text-base font-[--font-family-mono] text-[11px]">
                          www.example.com
                        </code>
                      </p>
                    </div>
                  </Show>

                  <Show when={state.domainError}>
                    <div
                      class="rounded-lg border px-3 py-2 text-12-regular"
                      style={{
                        "border-color": "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 25%, transparent)",
                        background: "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 6%, transparent)",
                        color: "var(--text-on-critical-base, #ef4444)",
                      }}
                    >
                      {state.domainError}
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Custom domain section - Workers */}
              <Show when={!isPlatformDeployment() && isWorkersDeployment()}>
                <div class="flex flex-col gap-3">
                  <div
                    class="h-px w-full"
                    style={{ background: "linear-gradient(90deg, var(--border-base, rgba(0,0,0,0.08)), transparent)" }}
                  />
                  <div class="flex items-center gap-2">
                    <Icon name="link" size="small" class="text-icon-muted" />
                    <span class="text-13-medium text-text-strong">{language.t("publish.domain.title")}</span>
                  </div>

                  <Show when={state.loadingDomains}>
                    <div class="flex flex-col gap-2.5">
                      <div
                        class="h-9 w-full animate-pulse rounded-lg"
                        style={{
                          background: "color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.08)) 40%, transparent)",
                        }}
                      />
                    </div>
                  </Show>

                  <Show when={!state.loadingDomains && state.customDomains.length > 0}>
                    <For each={state.customDomains}>
                      {(domain) => (
                        <div class="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-muted/50 p-3.5">
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2.5">
                              <span class={`h-2 w-2 rounded-full ${domainStatusDotColor(domain.status)}`} />
                              <span class="text-13-medium text-text-strong">{domain.domain}</span>
                            </div>
                            <span class={`text-12-medium ${domainStatusColor(domain.status)}`}>
                              {domainStatusLabel(domain.status)}
                            </span>
                          </div>

                          <Show when={domain.status !== "active"}>
                            <div
                              class="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
                              style={{
                                "background-image":
                                  "radial-gradient(circle, color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.1)) 40%, transparent) 0.4px, transparent 0.4px)",
                                "background-size": "12px 12px",
                                "background-color": "var(--surface-inset-base, #fafafa)",
                              }}
                            >
                              <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                {language.t("publish.ns.title")}
                              </span>
                              <p class="text-12-regular text-text-muted leading-relaxed">
                                {language.t("publish.ns.replace", { domain: domain.domain })}
                              </p>
                              <div class="flex flex-col gap-1 font-mono text-12-regular">
                                <For each={domain.nameservers ?? []}>
                                  {(ns) => (
                                    <div class="flex items-center gap-2 rounded bg-bg-primary px-2 py-1">
                                      <span class="text-text-base">{ns}</span>
                                    </div>
                                  )}
                                </For>
                              </div>
                              <p class="text-11-regular text-text-muted leading-relaxed mt-1">
                                {language.t("publish.ns.hint")}
                              </p>
                              <div class="flex flex-col gap-1.5 mt-2 pt-2 border-t border-border-subtle">
                                <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                  {language.t("publish.ns.help.title")}
                                </span>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                                  <a
                                    href="https://developers.cloudflare.com/dns/nameservers/update-nameservers/"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    {language.t("publish.ns.help.change")}
                                  </a>
                                  <a
                                    href="https://www.youtube.com/watch?v=TOqJtNQzHuM"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    {language.t("publish.ns.help.video")}
                                  </a>
                                </div>
                                <span class="text-11-medium text-text-muted mt-1">
                                  {language.t("publish.ns.help.providers")}
                                </span>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                                  <a
                                    href="https://www.namecheap.com/support/knowledgebase/article.aspx/767/2237/how-to-change-dns-servers"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    Namecheap
                                  </a>
                                  <a
                                    href="https://www.godaddy.com/en/help/change-my-domain-nameservers-664"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    GoDaddy
                                  </a>
                                  <a
                                    href="https://developers.cloudflare.com/dns/nameservers/"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                                  >
                                    {language.t("publish.ns.help.change.link")}
                                  </a>
                                </div>
                              </div>
                            </div>
                          </Show>

                          {/* DNS Verification Details - Workers */}
                          <Show when={state.dnsVerification}>
                            <div
                              class="flex flex-col gap-2 rounded-lg border p-3"
                              style={{
                                "border-color": state.dnsVerification?.nameservers_ok
                                  ? "color-mix(in srgb, #22c55e 30%, transparent)"
                                  : "color-mix(in srgb, #ef4444 30%, transparent)",
                                background: state.dnsVerification?.nameservers_ok
                                  ? "color-mix(in srgb, #22c55e 6%, var(--surface-inset-base, #fafafa))"
                                  : "color-mix(in srgb, #ef4444 6%, var(--surface-inset-base, #fafafa))",
                              }}
                            >
                              <span class="text-11-medium text-text-muted uppercase tracking-wider">
                                {language.t("publish.dns.verification")}
                              </span>
                              <div class="flex flex-col gap-1.5">
                                <div class="flex items-center gap-2">
                                  <span
                                    class={`h-2 w-2 rounded-full ${state.dnsVerification?.nameservers_ok ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"}`}
                                  />
                                  <span
                                    class={`text-12-regular ${state.dnsVerification?.nameservers_ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                                  >
                                    {state.dnsVerification?.nameservers_ok
                                      ? language.t("publish.ns.delegated")
                                      : language.t("publish.ns.notDelegated")}
                                  </span>
                                </div>
                              </div>
                              <Show
                                when={
                                  !state.dnsVerification?.nameservers_ok &&
                                  (state.dnsVerification?.expected_nameservers?.length ?? 0) > 0
                                }
                              >
                                <div class="flex flex-col gap-1 mt-1">
                                  <span class="text-11-medium text-text-muted">
                                    {language.t("publish.ns.expected")}
                                  </span>
                                  <For each={state.dnsVerification?.expected_nameservers ?? []}>
                                    {(ns) => <span class="font-mono text-11-regular text-text-base">{ns}</span>}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          </Show>

                          <div class="flex items-center justify-between">
                            <Show when={domain.status !== "active"}>
                              <button
                                type="button"
                                disabled={state.checkingDns}
                                onClick={handleCheckDns}
                                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40 cursor-pointer disabled:opacity-50"
                              >
                                <Show
                                  when={!state.checkingDns}
                                  fallback={
                                    <span class="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600 dark:border-blue-700 dark:border-t-blue-400" />
                                  }
                                >
                                  <Icon name="refresh" size="small" />
                                </Show>
                                {state.checkingDns ? language.t("publish.ns.checking") : language.t("publish.ns.check")}
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="flex items-center gap-1.5 rounded-md px-2 py-1 text-12-regular text-text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer disabled:opacity-50 ml-auto"
                              disabled={state.removingDomain === domain.domain}
                              onClick={() => handleRemoveDomain(domain.domain)}
                            >
                              <Icon name="trash" size="small" />
                              {state.removingDomain === domain.domain
                                ? language.t("publish.domain.remove.removing")
                                : language.t("publish.domain.remove.action")}
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>

                  {/* Zone setup result - show nameservers */}
                  <Show when={state.zoneSetup}>
                    <div
                      class="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
                      style={{
                        "background-image":
                          "radial-gradient(circle, color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.1)) 40%, transparent) 0.4px, transparent 0.4px)",
                        "background-size": "12px 12px",
                        "background-color": "var(--surface-inset-base, #fafafa)",
                      }}
                    >
                      <span class="text-11-medium text-text-muted uppercase tracking-wider">
                        {language.t("publish.ns.title")}
                      </span>
                      <p class="text-12-regular text-text-muted leading-relaxed">
                        {language.t("publish.ns.replace", { domain: state.zoneSetup?.name ?? "" })}
                      </p>
                      <div class="flex flex-col gap-1 font-mono text-12-regular">
                        <For each={state.zoneSetup?.name_servers ?? []}>
                          {(ns) => (
                            <div class="flex items-center gap-2 rounded bg-bg-primary px-2 py-1">
                              <span class="text-text-base">{ns}</span>
                            </div>
                          )}
                        </For>
                      </div>
                      <p class="text-11-regular text-text-muted leading-relaxed mt-1">
                        {language.t("publish.ns.hint.zone")}
                      </p>
                      <div class="flex flex-col gap-1.5 mt-2 pt-2 border-t border-border-subtle">
                        <span class="text-11-medium text-text-muted uppercase tracking-wider">
                          {language.t("publish.ns.help.title")}
                        </span>
                        <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                          <a
                            href="https://developers.cloudflare.com/dns/nameservers/update-nameservers/"
                            target="_blank"
                            rel="noopener"
                            class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                          >
                            {language.t("publish.ns.help.change")}
                          </a>
                          <a
                            href="https://www.youtube.com/watch?v=TOqJtNQzHuM"
                            target="_blank"
                            rel="noopener"
                            class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                          >
                            {language.t("publish.ns.help.video")}
                          </a>
                        </div>
                        <span class="text-11-medium text-text-muted mt-1">
                          {language.t("publish.ns.help.providers")}
                        </span>
                        <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular">
                          <a
                            href="https://www.namecheap.com/support/knowledgebase/article.aspx/767/2237/how-to-change-dns-servers"
                            target="_blank"
                            rel="noopener"
                            class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                          >
                            Namecheap
                          </a>
                          <a
                            href="https://www.godaddy.com/en/help/change-my-domain-nameservers-664"
                            target="_blank"
                            rel="noopener"
                            class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                          >
                            GoDaddy
                          </a>
                          <a
                            href="https://developers.cloudflare.com/dns/nameservers/"
                            target="_blank"
                            rel="noopener"
                            class="text-blue-600 hover:underline dark:text-blue-400 cursor-pointer"
                          >
                            {language.t("publish.ns.help.change.link")}
                          </a>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={state.checkingNameservers}
                        onClick={handleCheckNameservers}
                        class="flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-12-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40 cursor-pointer disabled:opacity-50 mt-1"
                      >
                        <Show
                          when={!state.checkingNameservers}
                          fallback={
                            <span class="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600 dark:border-blue-700 dark:border-t-blue-400" />
                          }
                        >
                          <Icon name="refresh" size="small" />
                        </Show>
                        {state.checkingNameservers ? language.t("publish.ns.checking") : language.t("publish.ns.check")}
                      </button>
                    </div>
                  </Show>

                  <Show when={!state.loadingDomains && state.customDomains.length === 0 && !state.zoneSetup}>
                    <div class="flex flex-col gap-2.5">
                      <div class="flex gap-2">
                        <input
                          type="text"
                          value={state.customDomainInput}
                          onInput={(e) => {
                            setState("customDomainInput", e.currentTarget.value)
                            setState("domainTouched", false)
                          }}
                          placeholder="app.example.com"
                          class={`flex-1 rounded-lg border bg-bg-primary px-3 py-2 text-13-regular text-text-strong placeholder:text-text-muted transition-colors focus:outline-none focus:ring-2 ${
                            state.domainTouched && !isValidDomain(state.customDomainInput)
                              ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
                              : "border-border-subtle focus:border-blue-500 focus:ring-blue-500/20"
                          }`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && isValidDomain(state.customDomainInput)) handleAddWorkerDomain()
                          }}
                        />
                        <Button
                          onClick={handleAddWorkerDomain}
                          disabled={
                            state.addingDomain || state.settingUpZone || !isValidDomain(state.customDomainInput)
                          }
                          variant="primary"
                          size="small"
                        >
                          {state.settingUpZone ? (
                            <span class="flex items-center gap-1.5">
                              <span class="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              {language.t("publish.domain.settingUp")}
                            </span>
                          ) : state.addingDomain ? (
                            <span class="flex items-center gap-1.5">
                              <span class="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              {language.t("publish.domain.adding")}
                            </span>
                          ) : (
                            language.t("publish.domain.add")
                          )}
                        </Button>
                      </div>
                      <p class="text-11-regular text-text-muted leading-relaxed">
                        {language.t("publish.domain.add.hint.zone")}
                      </p>
                    </div>
                  </Show>

                  <Show when={state.domainError}>
                    <div
                      class="rounded-lg border px-3 py-2 text-12-regular"
                      style={{
                        "border-color": "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 25%, transparent)",
                        background: "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 6%, transparent)",
                        color: "var(--text-on-critical-base, #ef4444)",
                      }}
                    >
                      {state.domainError}
                    </div>
                  </Show>

                  <Show when={state.zoneError}>
                    <div
                      class="rounded-lg border px-3 py-2 text-12-regular"
                      style={{
                        "border-color": "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 25%, transparent)",
                        background: "color-mix(in srgb, var(--text-on-critical-base, #ef4444) 6%, transparent)",
                        color: "var(--text-on-critical-base, #ef4444)",
                      }}
                    >
                      {state.zoneError}
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Actions */}
              <div class="flex gap-2">
                <Button
                  onClick={handleRedeploy}
                  disabled={state.deploying}
                  variant="primary"
                  size="large"
                  class="flex-1"
                >
                  {state.deploying ? (
                    <span class="flex items-center justify-center gap-2">
                      <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      {state.deployStatus || language.t("publish.deploy.deploying")}
                    </span>
                  ) : (
                    language.t("publish.redeploy.action")
                  )}
                </Button>
                <Button onClick={handleDelete} variant="secondary" size="large">
                  {language.t("publish.delete.action")}
                </Button>
              </div>
            </div>
          </Show>
        </div>
      </Dialog>
    </>
  )
}
