import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { GlobalPreviewAuditResponse } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { getPreviewUrl } from "@/context/preview-lifecycle"
import { useServerSDK } from "@/context/server-sdk"
import {
  formFactors,
  scoreTone,
  type LighthouseFinding,
  type LighthouseFormFactor,
  type LighthouseResult,
} from "./lighthouse/types"
import "./session-seo-tab.css"

type WireResult = NonNullable<GlobalPreviewAuditResponse["result"]>
type WireFinding = WireResult["failed"][number]

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

export function SessionSeoTab() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [formFactor, setFormFactor] = createSignal<LighthouseFormFactor>("mobile")
  const [state, setState] = createStore({
    running: false,
    result: null as LighthouseResult | null,
    error: null as string | null,
  })

  const ensurePreview = async () => {
    if (getPreviewUrl(sdk().directory)) return
    const started = await serverSDK().client.global.preview.start({ directory: sdk().directory })
    if (!started.data?.success) throw new Error("No preview server is running for this project.")
  }

  const run = async () => {
    if (state.running) return
    setState({ running: true, error: null })
    try {
      await ensurePreview()
      const response = await serverSDK().client.global.preview.audit({
        directory: sdk().directory,
        formFactor: formFactor(),
      })
      const data = response.data
      if (!data?.success || !data.result) throw new Error(data?.error || "The audit could not be run.")
      setState("result", normalizeResult(data.result))
    } catch (err) {
      setState("error", err instanceof Error ? err.message : "The audit could not be run.")
    } finally {
      setState("running", false)
    }
  }

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
                >
                  {language.t(option.label)}
                </button>
              )}
            </For>
          </div>
          <Button onClick={run} disabled={state.running} variant="primary" class="ml-auto">
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
                    <For each={result().failed}>{(finding) => <FindingRow finding={finding} />}</For>
                  </div>
                </details>
              </Show>

              <div class="session-seo-target">
                <span>{language.t("session.tools.seo.audited")}</span>
                <code>{result().url}</code>
              </div>
            </div>
          )}
        </Show>
      </div>
    </ScrollView>
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

function FindingRow(props: { finding: LighthouseFinding }) {
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
