import { createEffect, createSignal, Show, For, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionFilePanelV2, SessionFilePanelV2Title } from "@opencode-ai/session-ui/v2/session-file-panel-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { SessionGitTab } from "./session-git-tab"
import { SessionCheckpointsTab } from "./session-checkpoints-tab"
import { SessionSeoTab } from "./session-seo-tab"
import "./session-tools-tab.css"

interface Deployment {
  id: string
  name: string
  label: string
  url: string
  status: string
  runtime?: string
  created_at: number
}

interface CustomDomain {
  domain: string
  status: string
  cname_target: string
  nameservers?: string[]
}

const errorMessage = (err: { message?: string; data?: { message?: string } } | null | undefined) =>
  err?.data?.message || err?.message || ""

const deploymentDotColor = (status: string) => {
  switch (status) {
    case "live":
      return "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
    case "deploying":
      return "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]"
    default:
      return "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
  }
}

const deploymentStatusLabel = (status: string, t: (key: string) => string) => {
  switch (status) {
    case "live":
      return t("session.tools.publishing.status.live")
    case "deploying":
      return t("session.tools.publishing.status.deploying")
    default:
      return t("session.tools.publishing.status.failed")
  }
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

const domainStatusLabel = (status: string, t: (key: string) => string) => {
  switch (status) {
    case "active":
      return t("session.tools.domains.status.active")
    case "pending":
    case "initializing":
      return t("session.tools.domains.status.pending")
    default:
      return t("session.tools.domains.status.error")
  }
}

export interface SessionToolsTabProps {
  onSelectCheckpoint?: (checkpointID: string) => void
}

export function SessionToolsTab(props: SessionToolsTabProps = {}) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [tab, setTab] = createSignal("publishing")
  const [state, setState] = createStore({
    loaded: false,
    existing: null as Deployment | null,
    customDomains: [] as CustomDomain[],
    deploying: false,
    deployStatus: "",
    error: null as string | null,
    copied: false,
    customDomainInput: "",
    domainTouched: false,
    addingDomain: false,
    domainError: null as string | null,
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

  const isWorkersDeployment = () => {
    const r = state.existing?.runtime
    const url = state.existing?.url || ""
    return r === "workers" || (!url.endsWith(".pages.dev") && r !== "pages")
  }

  const load = async (directory: string) => {
    try {
      const params = new URLSearchParams({ directory })
      const [deployRes, domainRes] = await Promise.all([
        fetch(`${sdk().url}/publish?${params}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }),
        fetch(`${sdk().url}/publish/domain?${params}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }),
      ])
      if (deployRes.ok) {
        const result = await deployRes.json()
        const rows = Array.isArray(result) ? result : []
        // Prefer the server row when present, but keep the persisted snapshot otherwise:
        // a deployment may be live on Cloudflare even if its database row was lost.
        if (rows.length > 0) setState("existing", rows[0])
      }
      if (domainRes.ok) {
        const result = await domainRes.json()
        setState("customDomains", Array.isArray(result) ? result : [])
      }
    } catch (err) {
      console.error("Failed to load publish state:", err)
    } finally {
      setState("loadingDomains", false)
      setState("loaded", true)
    }
  }

  createEffect(() => {
    const directory = sdk().directory
    // The persisted snapshot only seeds the initial state. Reading it reactively creates a
    // loop: load() writes state, the effect above mirrors state into the snapshot, which
    // re-triggers this effect and refetches forever. Re-run only when the directory changes.
    untrack(() => {
      setState("existing", snapshot.existing)
      setState("customDomains", snapshot.customDomains)
      setState("loaded", false)
      setState("loadingDomains", true)
      void load(directory)
    })
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
        setState("loadingDomains", true)
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

  const handleCopyUrl = async () => {
    const dep = state.existing
    if (!dep) return
    try {
      await navigator.clipboard.writeText(dep.url)
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    } catch {
      showToast({ title: language.t("publish.copyUrl.failed") })
    }
  }

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
                      showToast({ title: errorMessage(err) || language.t("publish.domain.remove.failed") })
                    }
                  } catch (err: unknown) {
                    showToast({
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

  const addDomainForm = (
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
          if (e.key === "Enter" && isValidDomain(state.customDomainInput)) {
            if (isWorkersDeployment()) handleAddWorkerDomain()
            else handleAddDomain()
          }
        }}
      />
      <Button
        onClick={isWorkersDeployment() ? handleAddWorkerDomain : handleAddDomain}
        disabled={state.addingDomain || state.settingUpZone || !isValidDomain(state.customDomainInput)}
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
  )

  return (
    <SessionFilePanelV2
      toolbar
      toolbarStart={<SessionFilePanelV2Title>{language.t("session.tools.title")}</SessionFilePanelV2Title>}
    >
      <TabsV2 orientation="vertical" variant="settings" value={tab()} onChange={setTab} class="session-tools-tab">
        <TabsV2.List>
          <TabsV2.Trigger value="publishing">
            <Icon name="cloud-upload" />
            {language.t("session.tools.tab.publishing")}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="domains">
            <Icon name="wheel-globe" />
            {language.t("session.tools.tab.domains")}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="git">
            <Icon name="branch" />
            {language.t("git.tab")}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="checkpoints">
            <IconV2 name="history" />
            {language.t("session.checkpoint.title")}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="seo">
            <Icon name="glasses" />
            {language.t("session.tools.tab.seo")}
          </TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="publishing" class="session-tools-tab-panel">
          <div class="session-tools-tab-header">
            <div class="text-16-medium text-v2-text-text-base">{language.t("session.tools.publishing.title")}</div>
            <div class="text-13-regular text-v2-text-text-muted">
              {language.t("session.tools.publishing.description")}
            </div>
          </div>
          <div class="flex flex-col gap-1.5 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
            <div class="text-12-medium text-v2-text-text-muted">{language.t("session.tools.publishing.status")}</div>
            <Show
              when={state.loaded && state.existing}
              fallback={
                <div class="flex items-center gap-2">
                  <Show
                    when={state.loaded}
                    fallback={<span class="size-2 animate-pulse rounded-full bg-v2-text-text-muted" />}
                  >
                    <span class="size-2 rounded-full bg-v2-text-text-muted" />
                  </Show>
                  <span class="text-14-medium text-v2-text-text-base">
                    {state.loaded
                      ? language.t("session.tools.publishing.unpublished")
                      : `${language.t("common.loading")}...`}
                  </span>
                </div>
              }
            >
              {(deployment) => {
                const dep = deployment()
                return (
                  <div class="flex flex-col gap-0.5">
                    <div class="flex items-center gap-2">
                      <span class={`size-2 rounded-full ${deploymentDotColor(dep.status)}`} />
                      <span class="text-14-medium text-v2-text-text-base">
                        {deploymentStatusLabel(dep.status, language.t)}
                      </span>
                    </div>
                    <Show when={dep.status === "live" && dep.url}>
                      <div class="flex items-center gap-1.5">
                        <a
                          href={dep.url}
                          target="_blank"
                          class="min-w-0 flex-1 truncate text-12-regular text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {dep.url}
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
                    </Show>
                  </div>
                )
              }}
            </Show>
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
            <Show when={state.loaded}>
              <Button
                onClick={state.existing ? handleRedeploy : handleDeploy}
                disabled={state.deploying}
                variant="primary"
                size="large"
                class="w-full"
              >
                <span class="flex items-center justify-center gap-2">
                  <Show when={state.deploying} fallback={<Icon name="cloud-upload" size="small" />}>
                    <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  </Show>
                  {state.deploying
                    ? state.deployStatus || language.t("publish.deploy.deploying")
                    : state.existing
                      ? language.t("publish.redeploy.action")
                      : language.t("publish.deploy.action")}
                </span>
              </Button>
            </Show>
          </div>
        </TabsV2.Content>
        <TabsV2.Content value="domains" class="session-tools-tab-panel">
          <div class="session-tools-tab-header">
            <div class="text-16-medium text-v2-text-text-base">{language.t("session.tools.tab.domains")}</div>
            <div class="text-13-regular text-v2-text-text-muted">{language.t("session.tools.domains.description")}</div>
          </div>
          <Show when={state.loaded && !state.existing}>
            <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 text-13-regular text-v2-text-text-muted">
              {language.t("session.tools.domains.unpublished")}
            </div>
          </Show>
          <Show when={state.loaded && state.existing}>
            <div class="flex flex-col gap-3">
              <Show when={state.loadingDomains}>
                <div class="flex flex-col gap-2.5">
                  <div
                    class="h-9 w-full animate-pulse rounded-lg"
                    style={{ background: "color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.08)) 40%, transparent)" }}
                  />
                  <div
                    class="h-3 w-3/4 animate-pulse rounded"
                    style={{ background: "color-mix(in srgb, var(--text-weaker, rgba(0,0,0,0.08)) 40%, transparent)" }}
                  />
                </div>
              </Show>

              <Show when={!state.loadingDomains && state.customDomains.length > 0}>
                <div class="flex flex-col gap-2">
                  <For each={state.customDomains}>
                    {(domain) => (
                      <div class="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-muted/50 p-3.5">
                        <div class="flex items-center justify-between">
                          <div class="flex items-center gap-2.5">
                            <span class={`h-2 w-2 rounded-full ${domainStatusDotColor(domain.status)}`} />
                            <span class="text-13-medium text-text-strong">{domain.domain}</span>
                          </div>
                          <span class="text-12-medium text-v2-text-text-muted">
                            {domainStatusLabel(domain.status, language.t)}
                          </span>
                        </div>

                        <Show when={domain.status !== "active" && !isWorkersDeployment()}>
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
                          </div>
                        </Show>

                        <Show
                          when={
                            domain.status !== "active" && isWorkersDeployment() && (domain.nameservers?.length ?? 0) > 0
                          }
                        >
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
                          </div>
                        </Show>

                        <Show when={state.dnsVerification}>
                          <div class="flex flex-col gap-2">
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
                              {state.checkingDns ? language.t("publish.dns.checking") : language.t("publish.dns.check")}
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
                </div>
              </Show>

              <Show when={!state.loadingDomains && state.customDomains.length === 0 && !state.zoneSetup}>
                <div class="flex flex-col gap-2.5">
                  {addDomainForm}
                  <p class="text-11-regular text-text-muted leading-relaxed">
                    {isWorkersDeployment()
                      ? language.t("publish.domain.add.hint.zone")
                      : language.t("publish.domain.add.hint.prefix")}{" "}
                    <code class="rounded bg-bg-muted px-1 py-0.5 text-text-base font-[--font-family-mono] text-[11px]">
                      app.example.com
                    </code>{" "}
                    {isWorkersDeployment() ? null : language.t("publish.domain.add.hint.suffix")}{" "}
                    {isWorkersDeployment() ? null : (
                      <code class="rounded bg-bg-muted px-1 py-0.5 text-text-base font-[--font-family-mono] text-[11px]">
                        www.example.com
                      </code>
                    )}
                  </p>
                </div>
              </Show>

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
        </TabsV2.Content>
        <TabsV2.Content value="git" class="session-tools-tab-panel">
          <SessionGitTab />
        </TabsV2.Content>
        <TabsV2.Content value="checkpoints" class="session-tools-tab-panel">
          <SessionCheckpointsTab onSelectCheckpoint={props.onSelectCheckpoint} />
        </TabsV2.Content>
        <TabsV2.Content value="seo" class="session-tools-tab-panel">
          <SessionSeoTab />
        </TabsV2.Content>
      </TabsV2>
    </SessionFilePanelV2>
  )
}
