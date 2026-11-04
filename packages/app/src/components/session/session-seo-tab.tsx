import { createEffect, createMemo, getOwner } from "solid-js"
import { useParams } from "@solidjs/router"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { getPreviewUrl } from "@/context/preview-lifecycle"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SeoProvider, useSeo } from "./seo/context"
import { SeoPanel } from "./seo/panel"
import type { GlobalPreviewReportResponse } from "@opencode-ai/sdk/v2/client"
import type { Audit } from "./seo/types"
import { auditView } from "./seo/view"

/** The Tools tab's SEO tool: the website audit, its PDF report and fixes by the agent. */
export function SessionSeoTab() {
  return (
    <SeoProvider>
      <SeoTab />
    </SeoProvider>
  )
}

function SeoTab() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const sync = useSync()
  const local = useLocal()
  const language = useLanguage()
  const seo = useSeo()
  const params = useParams<{ id?: string }>()

  const sessionID = () => params.id
  const busy = createMemo(() => {
    const id = sessionID()
    return id ? sync().data.session_working(id) : false
  })

  // The preview and the audit run on the project's own server (its MicroVM): a client without the project directory
  // is answered by the control plane, which holds no copy of the project and refuses the path.
  const projectClient = () => serverSDK().createClient({ directory: sdk().directory })

  const view = auditView(
    { scope: serverSDK().scope, directory: sdk().directory },
    {
      report: async (input) => {
        const response = await projectClient().global.preview.report(
          { body_directory: sdk().directory, formFactor: input.formFactor, url: input.url, locale: input.locale },
          { signal: input.signal },
        )
        // SAFETY: the server answers a failed audit with { success: false, error }.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const body = response.data ?? (response.error as { success?: boolean; error?: string } | undefined)

        if (!response.data?.success || !response.data.report)
          throw new Error(body?.error || language.t("common.requestFailed"))

        return fromWire(response.data.report)
      },
      ensurePreview: async () => {
        if (getPreviewUrl(sdk().directory)) return
        const started = await projectClient().global.preview.start({ body_directory: sdk().directory })
        if (started.data?.success) return
        // Say why the preview did not start, as the server put it, rather than a generic line.
        // SAFETY: the server answers a failed start with { success: false, error }.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const failure = started.error as { error?: string } | undefined
        const reason = started.data?.error ?? failure?.error
        throw new Error(
          reason
            ? `The preview could not start: ${reason}`
            : `The preview could not start (HTTP ${started.response?.status ?? "?"}).`,
        )
      },
      pdf: async (html) => {
        const response = await projectClient().global.preview.pdf({ body_directory: sdk().directory, html })
        // SAFETY: the server answers a failed audit with { success: false, error }.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const body = response.data ?? (response.error as { success?: boolean; error?: string } | undefined)

        if (!response.data?.success || !response.data.base64)
          throw new Error(body?.error || language.t("common.requestFailed"))

        return { base64: response.data.base64 }
      },
      prompt: async (text) => {
        const id = sessionID()
        if (!id) throw new Error(seo.t("optimize.noSession"))
        const model = local.model.current()
        const agent = local.agent.current()
        serverSync().session.set("session_status", id, { type: "busy" })
        await sdk()
          .client.session.promptAsync({
            sessionID: id,
            parts: [{ type: "text", text }],
            ...(agent?.name ? { agent: agent.name } : {}),
            ...(model ? { model: { providerID: model.provider.id, modelID: model.id } } : {}),
          })
          .catch((error: unknown) => {
            serverSync().session.set("session_status", id, { type: "idle" })
            throw error
          })
      },
      abort: async () => {
        const id = sessionID()
        if (!id) return
        await sdk().client.session.abort({ sessionID: id })
        serverSync().session.set("session_status", id, { type: "idle" })
      },
      t: seo.t,
      locale: () => seo.locale.locale(),
    },
    getOwner(),
  )

  // The agent's activity decides when a fix is done and the audit runs again.
  createEffect(() => view.setAgentBusy(busy()))

  return (
    <ScrollView class="session-seo-tab">
      <SeoPanel view={view} />
    </ScrollView>
  )
}

// The generated SDK types every number as Effect's JSON encoding, which also allows "NaN" and "Infinity" strings. The
// audit server only writes finite numbers, so the report is the server's own type.
function fromWire(report: NonNullable<GlobalPreviewReportResponse["report"]>): Audit.Report {
  // SAFETY: produced by preview/audit/report.ts, whose numbers are all finite.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return report as unknown as Audit.Report
}
