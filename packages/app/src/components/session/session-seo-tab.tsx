import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { GlobalPreviewAuditResponse } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { getPreviewUrl } from "@/context/preview-lifecycle"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  formFactors,
  scoreTone,
  type LighthouseFormFactor,
  type LighthouseFinding,
  type LighthouseResult,
} from "./lighthouse/types"
import {
  buildFindingPrompt,
  buildFixPrompt,
  compareResults,
  seoCategoryKeys,
  type SeoComparison,
  type SeoFindingChange,
} from "./lighthouse/auto-fix"
import "./session-seo-tab.css"

type WireResult = NonNullable<GlobalPreviewAuditResponse["result"]>
type WireFinding = WireResult["failed"][number]

type OptimizePhase = "idle" | "asking" | "running" | "auditing" | "stopped" | "done" | "error"

function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeFinding(finding: WireFinding): LighthouseFinding {
  return { id: finding.id, title: finding.title, display: finding.display, score: toNumber(finding.score) }
}

function normalizeResult(result: WireResult): LighthouseResult {
  return {
    url: result.url,
    fetch_time: result.fetch_time,
    categories: {
      performance: toNumber(result.categories.performance),
      accessibility: toNumber(result.categories.accessibility),
      best_practices: toNumber(result.categories.best_practices),
      seo: toNumber(result.categories.seo),
      agentic_browsing: toNumber(result.categories.agentic_browsing),
    },
    metrics: {
      fcp: result.metrics.fcp ?? null,
      lcp: result.metrics.lcp ?? null,
      tbt: result.metrics.tbt ?? null,
      cls: result.metrics.cls ?? null,
      si: result.metrics.si ?? null,
    },
    failed: result.failed.map(normalizeFinding),
    agentic_browsing: result.agentic_browsing
      ? {
          passed: toNumber(result.agentic_browsing.passed) ?? 0,
          total: toNumber(result.agentic_browsing.total) ?? 0,
          audits: result.agentic_browsing.audits.map(normalizeFinding),
        }
      : null,
  }
}

const GAUGES: [keyof LighthouseResult["categories"], string][] = [
  ["performance", "session.tools.seo.gauge.performance"],
  ["accessibility", "session.tools.seo.gauge.accessibility"],
  ["best_practices", "session.tools.seo.gauge.bestPractices"],
  ["seo", "session.tools.seo.gauge.seo"],
  ["agentic_browsing", "session.tools.seo.gauge.agentic"],
]

const METRICS: [string, keyof LighthouseResult["metrics"]][] = [
  ["FCP", "fcp"],
  ["LCP", "lcp"],
  ["TBT", "tbt"],
  ["CLS", "cls"],
  ["session.tools.seo.metric.speedIndex", "si"],
]

const formatDuration = (ms: number) => {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function SessionSeoTab() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const sync = useSync()
  const local = useLocal()
  const language = useLanguage()
  const params = useParams<{ id?: string }>()
  const [formFactor, setFormFactor] = createSignal<LighthouseFormFactor>("mobile")
  const [now, setNow] = createSignal(Date.now())
  const [state, setState] = createStore({
    running: false,
    result: null as LighthouseResult | null,
    error: null as string | null,
    fix: {
      phase: "idle" as OptimizePhase,
      scope: "all" as "all" | string,
      targetIds: [] as string[],
      baseline: null as LighthouseResult | null,
      formFactor: "mobile" as LighthouseFormFactor,
      startedAt: null as number | null,
      sawBusy: false,
      comparison: null as SeoComparison | null,
      error: null as string | null,
    },
  })

  const sessionID = () => params.id
  const busy = createMemo(() => {
    const id = sessionID()
    return id ? sync().data.session_working(id) : false
  })
  const fixActive = createMemo(
    () => state.fix.phase === "asking" || state.fix.phase === "running" || state.fix.phase === "auditing",
  )
  const canOptimize = createMemo(() => !!state.result && !!sessionID() && !state.running && !busy() && !fixActive())
  const elapsed = () => (state.fix.startedAt ? Math.max(0, now() - state.fix.startedAt) : 0)

  createEffect(() => {
    if (!fixActive()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (state.fix.phase !== "running") return
    const id = sessionID()
    if (!id) return
    if (sync().data.session_working(id)) {
      if (!state.fix.sawBusy) setState("fix", "sawBusy", true)
      return
    }
    if (state.fix.sawBusy) void finalizeFix()
  })

  const ensurePreview = async () => {
    if (getPreviewUrl(sdk().directory)) return
    const started = await serverSDK().client.global.preview.start({ body_directory: sdk().directory })
    if (!started.data?.success) throw new Error("No preview server is running for this project.")
  }

  const audit = async (factor: LighthouseFormFactor): Promise<LighthouseResult | null> => {
    await ensurePreview()
    const response = await serverSDK().client.global.preview.audit({ body_directory: sdk().directory, formFactor: factor })
    const data = response.data
    if (!data?.success || !data.result) throw new Error(data?.error || "The audit could not be run.")
    return normalizeResult(data.result)
  }

  const run = async () => {
    if (state.running || fixActive()) return
    setState("running", true)
    setState("error", null)
    try {
      const result = await audit(formFactor())
      if (result) setState("result", result)
    } catch (err) {
      setState("error", err instanceof Error ? err.message : "The audit could not be run.")
    } finally {
      setState("running", false)
    }
  }

  const startOptimize = async (scope: "all" | string) => {
    const result = state.result
    const id = sessionID()
    if (!result || !id || !canOptimize()) return
    const targets = scope === "all" ? result.failed : result.failed.filter((finding) => finding.id === scope)
    if (scope !== "all" && targets.length === 0) return
    const text =
      scope === "all" ? buildFixPrompt(result, formFactor()) : buildFindingPrompt(result, scope, formFactor())

    setState("fix", {
      phase: "asking",
      scope,
      targetIds: targets.map((finding) => finding.id),
      baseline: result,
      formFactor: formFactor(),
      startedAt: Date.now(),
      sawBusy: false,
      comparison: null,
      error: null,
    })
    setNow(Date.now())
    serverSync().session.set("session_status", id, { type: "busy" })

    try {
      const model = local.model.current()
      const agent = local.agent.current()
      await sdk().client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text }],
        ...(agent?.name ? { agent: agent.name } : {}),
        ...(model ? { model: { providerID: model.provider.id, modelID: model.id } } : {}),
      })
      if (state.fix.phase === "asking") setState("fix", "phase", "running")
    } catch (err) {
      serverSync().session.set("session_status", id, { type: "idle" })
      setState("fix", "phase", "error")
      setState("fix", "error", err instanceof Error ? err.message : language.t("common.requestFailed"))
    }
  }

  const stopOptimize = async () => {
    const id = sessionID()
    if (!id) return
    await sdk()
      .client.session.abort({ sessionID: id })
      .catch(() => {})
    serverSync().session.set("session_status", id, { type: "idle" })
    setState("fix", "sawBusy", false)
    setState("fix", "phase", "stopped")
  }

  const finalizeFix = async () => {
    if (state.fix.phase !== "running") return
    const baseline = state.fix.baseline
    const factor = state.fix.formFactor
    setState("fix", "phase", "auditing")
    try {
      const after = await audit(factor)
      if (!after) {
        setState("fix", "phase", "error")
        setState("fix", "error", language.t("session.tools.seo.optimize.auditFailed"))
        return
      }
      setState("result", after)
      setState("fix", "comparison", baseline ? compareResults(baseline, after) : null)
      setState("fix", "phase", "done")
    } catch (err) {
      setState("fix", "phase", "error")
      setState("fix", "error", err instanceof Error ? err.message : language.t("common.requestFailed"))
    }
  }

  const resetOptimize = () => {
    setState("fix", {
      phase: "idle",
      scope: "all",
      targetIds: [],
      baseline: null,
      formFactor: formFactor(),
      startedAt: null,
      sawBusy: false,
      comparison: null,
      error: null,
    })
  }

  const phaseTitle = () =>
    state.fix.phase === "auditing"
      ? language.t("session.tools.seo.optimize.auditing")
      : language.t("session.tools.seo.optimize.working")

  const phaseDetail = () =>
    state.fix.scope === "all"
      ? language.t("session.tools.seo.optimize.workingAll", { count: state.fix.targetIds.length })
      : language.t("session.tools.seo.optimize.workingOne")

  return (
    <ScrollView class="session-seo-tab">
      <div class="session-seo-tab-content">
        <div class="session-tools-tab-header">
          <div class="text-16-medium text-v2-text-text-base">{language.t("session.tools.seo.title")}</div>
          <div class="text-13-regular text-v2-text-text-muted">{language.t("session.tools.seo.description")}</div>
        </div>

        <div class="session-seo-controls">
          <div class="session-seo-viewport">
            <For each={formFactors}>
              {(option) => (
                <button
                  type="button"
                  class="session-seo-viewport-option"
                  classList={{ "is-active": formFactor() === option.key }}
                  onClick={() => setFormFactor(option.key)}
                  disabled={fixActive()}
                >
                  {language.t(option.label)}
                </button>
              )}
            </For>
          </div>
          <Button onClick={run} disabled={state.running || fixActive()} variant="primary" class="ml-auto">
            <span class="flex items-center justify-center gap-2">
              <Show when={state.running} fallback={<Icon name="refresh" size="small" />}>
                <span class="session-seo-spinner" />
              </Show>
              {state.running
                ? language.t("session.tools.seo.action.running")
                : state.result
                  ? language.t("session.tools.seo.action.retest")
                  : language.t("session.tools.seo.action.create")}
            </span>
          </Button>
        </div>

        <Show when={state.error}>
          <div class="session-seo-error">{state.error}</div>
        </Show>

        <Show when={state.running}>
          <div class="session-seo-loading">
            <span class="session-seo-spinner lg" />
            <div>
              <b>{language.t("session.tools.seo.running.title")}</b>
              <span>{language.t("session.tools.seo.running.description")}</span>
            </div>
          </div>
        </Show>

        <Show when={!state.running && !state.result && !state.error}>
          <div class="session-seo-empty">
            <Icon name="magnifying-glass" />
            <div>
              <b>{language.t("session.tools.seo.empty.title")}</b>
              <span>{language.t("session.tools.seo.empty.description")}</span>
            </div>
          </div>
        </Show>

        <Show when={state.result}>
          {(result) => (
            <>
              <div class="session-seo-audit">
                <div class="session-seo-audit-head">
                  <span class="session-seo-kicker">{language.t("session.tools.seo.source")}</span>
                  <em>{new Date(result().fetch_time).toLocaleString()}</em>
                </div>

                <div class="session-seo-gauges">
                  <For each={GAUGES}>
                    {([key, label]) => <Gauge score={result().categories[key]} label={language.t(label)} />}
                  </For>
                </div>

                <Show when={result().agentic_browsing && result().agentic_browsing!.total > 0}>
                  <div class="session-seo-audit-note">
                    {language.t("session.tools.seo.agentic.passed", {
                      passed: result().agentic_browsing!.passed,
                      total: result().agentic_browsing!.total,
                    })}
                  </div>
                </Show>

                <div class="session-seo-metrics">
                  <For each={METRICS}>
                    {([label, key]) => (
                      <Metric
                        label={label.startsWith("session.") ? language.t(label) : label}
                        value={result().metrics[key]}
                      />
                    )}
                  </For>
                </div>

                <Show when={result().failed.length > 0}>
                  <details class="session-seo-minor">
                    <summary>{language.t("session.tools.seo.findings", { count: result().failed.length })}</summary>
                    <div class="session-seo-minor-list">
                      <For each={result().failed}>
                        {(finding) => (
                          <FindingRow
                            finding={finding}
                            canFix={canOptimize()}
                            onFix={() => startOptimize(finding.id)}
                          />
                        )}
                      </For>
                    </div>
                  </details>
                </Show>

                <div class="session-seo-target">
                  <span>{language.t("session.tools.seo.audited")}</span>
                  <code>{result().url}</code>
                </div>
              </div>

              <div class="session-seo-optimize">
                <div class="session-seo-optimize-head">
                  <span class="session-seo-kicker">{language.t("session.tools.seo.optimize.kicker")}</span>
                  <div class="session-seo-optimize-title">{language.t("session.tools.seo.optimize.title")}</div>
                  <div class="session-seo-optimize-desc">{language.t("session.tools.seo.optimize.description")}</div>
                </div>

                <Show when={fixActive()}>
                  <div class="session-seo-fixing">
                    <span class="session-seo-spinner lg" />
                    <div class="session-seo-fixing-text">
                      <b>{phaseTitle()}</b>
                      <span>{phaseDetail()}</span>
                    </div>
                    <span class="session-seo-timer">{formatDuration(elapsed())}</span>
                    <Show when={state.fix.phase !== "auditing"}>
                      <Button variant="secondary" size="small" icon="stop" onClick={stopOptimize}>
                        {language.t("session.tools.seo.optimize.stop")}
                      </Button>
                    </Show>
                  </div>
                </Show>

                <Show when={state.fix.phase === "stopped"}>
                  <div class="session-seo-note is-warn">
                    <Icon name="warning" size="small" />
                    <span>{language.t("session.tools.seo.optimize.stopped")}</span>
                  </div>
                </Show>

                <Show when={state.fix.phase === "error" && state.fix.error}>
                  <div class="session-seo-note is-error">
                    <Icon name="warning" size="small" />
                    <span>{state.fix.error}</span>
                  </div>
                </Show>

                <Show when={!fixActive()}>
                  <div class="session-seo-optimize-actions">
                    <Button
                      variant="primary"
                      icon="arrow-up"
                      onClick={() => startOptimize("all")}
                      disabled={!canOptimize()}
                    >
                      {language.t("session.tools.seo.optimize.all")}
                    </Button>
                    <span class="session-seo-optimize-count">
                      {language.t("session.tools.seo.optimize.issueCount", { count: result().failed.length })}
                    </span>
                    <Show when={busy()}>
                      <span class="session-seo-optimize-hint">
                        {language.t("session.tools.seo.optimize.agentBusy")}
                      </span>
                    </Show>
                    <Show when={!sessionID()}>
                      <span class="session-seo-optimize-hint">
                        {language.t("session.tools.seo.optimize.noSession")}
                      </span>
                    </Show>
                  </div>
                </Show>

                <Show when={state.fix.comparison}>
                  {(comparison) => (
                    <OptimizeResult
                      comparison={comparison()}
                      canRetry={canOptimize()}
                      onRetry={() => startOptimize("all")}
                      onDismiss={resetOptimize}
                    />
                  )}
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </ScrollView>
  )
}

function OptimizeResult(props: {
  comparison: SeoComparison
  canRetry: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const language = useLanguage()
  const categoryLabel = (key: (typeof seoCategoryKeys)[number]) => {
    const match = GAUGES.find(([gauge]) => gauge === key)
    return match ? language.t(match[1]) : key
  }
  const summary = () => {
    const comparison = props.comparison
    if (comparison.fixed === 0 && !comparison.improved)
      return language.t("session.tools.seo.optimize.result.noProgress")
    return language.t("session.tools.seo.optimize.result.summary", {
      fixed: comparison.fixed,
      total: comparison.totalBefore,
    })
  }
  const deltaTone = (delta: number | null) => (delta === null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat")
  return (
    <div class="session-seo-result">
      <div class="session-seo-result-head">
        <span class="session-seo-kicker">{language.t("session.tools.seo.optimize.result.title")}</span>
        <span
          class="session-seo-verdict"
          classList={{ "is-good": props.comparison.improved, "is-bad": !props.comparison.improved }}
        >
          {summary()}
        </span>
      </div>

      <div class="session-seo-deltas">
        <For each={props.comparison.categories}>
          {(category) => (
            <div class="session-seo-delta">
              <span class="session-seo-delta-label">{categoryLabel(category.key)}</span>
              <span class="session-seo-delta-values">
                {category.before ?? "–"}
                <Icon name="arrow-right" size="small" />
                {category.after ?? "–"}
              </span>
              <span class={`session-seo-delta-badge is-${deltaTone(category.delta)}`}>
                {category.delta === null ? "–" : category.delta > 0 ? `+${category.delta}` : category.delta}
              </span>
            </div>
          )}
        </For>
      </div>

      <div class="session-seo-changes">
        <For each={props.comparison.changes}>{(change) => <ChangeRow change={change} />}</For>
      </div>

      <div class="session-seo-result-actions">
        <Button variant="secondary" size="small" icon="refresh" onClick={props.onRetry} disabled={!props.canRetry}>
          {language.t("session.tools.seo.optimize.result.retry")}
        </Button>
        <Button variant="ghost" size="small" onClick={props.onDismiss}>
          {language.t("session.tools.seo.optimize.result.dismiss")}
        </Button>
      </div>
    </div>
  )
}

function ChangeRow(props: { change: SeoFindingChange }) {
  const language = useLanguage()
  const label = () =>
    props.change.status === "fixed"
      ? language.t("session.tools.seo.optimize.change.fixed")
      : props.change.status === "introduced"
        ? language.t("session.tools.seo.optimize.change.introduced")
        : language.t("session.tools.seo.optimize.change.remaining")
  const icon = () =>
    props.change.status === "fixed" ? "check-small" : props.change.status === "introduced" ? "warning" : "dash"
  return (
    <div class="session-seo-change">
      <span class={`session-seo-change-status is-${props.change.status}`}>
        <Icon name={icon()} size="small" />
        {label()}
      </span>
      <span class="session-seo-change-title">{props.change.finding.title}</span>
    </div>
  )
}

function Metric(props: { label: string; value: string | null }) {
  return (
    <div class="session-seo-metric">
      <span>{props.label}</span>
      <b>{props.value ?? "–"}</b>
    </div>
  )
}

function FindingRow(props: { finding: LighthouseFinding; canFix?: boolean; onFix?: () => void }) {
  const language = useLanguage()
  const severity = () => ((props.finding.score ?? 1) < 0.5 ? "critical" : "medium")
  return (
    <div class="session-seo-item">
      <div class="session-seo-item-head">
        <span class={`session-seo-sev is-${severity()}`}>
          {language.t(
            severity() === "critical" ? "session.tools.seo.severity.error" : "session.tools.seo.severity.warning",
          )}
        </span>
        <span class="session-seo-item-title">{props.finding.title}</span>
        <Show when={props.onFix}>
          <button type="button" class="session-seo-item-fix" disabled={!props.canFix} onClick={() => props.onFix?.()}>
            <Icon name="arrow-up" size="small" />
            {language.t("session.tools.seo.optimize.fixOne")}
          </button>
        </Show>
      </div>
      <Show when={props.finding.display}>
        <div class="session-seo-item-plain">{props.finding.display}</div>
      </Show>
    </div>
  )
}

function Gauge(props: { score: number | null; label: string }) {
  const value = () =>
    typeof props.score === "number" && Number.isFinite(props.score)
      ? Math.max(0, Math.min(100, Math.round(props.score)))
      : null
  const radius = 26
  const circumference = 2 * Math.PI * radius
  const dash = ((value() ?? 0) / 100) * circumference
  return (
    <div class="session-seo-gauge">
      <svg
        viewBox="0 0 64 64"
        width="74"
        height="74"
        role="img"
        aria-label={value() === null ? `${props.label}: not audited` : `${props.label}: ${value()} of 100`}
      >
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke="var(--v2-border-border-base, #e9edf3)"
          stroke-width="6"
        />
        <Show when={value() !== null}>
          <circle
            class={`session-seo-gauge-bar is-${scoreTone(value())}`}
            cx="32"
            cy="32"
            r={radius}
            fill="none"
            stroke-width="6"
            stroke-linecap="round"
            stroke-dasharray={`${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}`}
            transform="rotate(-90 32 32)"
          />
        </Show>
        <text
          class={`session-seo-gauge-number is-${scoreTone(value())}`}
          x="32"
          y="37"
          text-anchor="middle"
          font-size="16"
          font-weight="600"
        >
          {value() === null ? "–" : value()}
        </text>
      </svg>
      <span>{props.label}</span>
    </div>
  )
}
