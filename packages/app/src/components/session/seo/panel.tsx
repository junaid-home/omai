import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import type { IconProps } from "@opencode-ai/ui/icon"
import type { Audit } from "./types"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSeo } from "./context"
import {
  CATEGORIES,
  METRICS,
  SEVERITIES,
  categoryLabel,
  checkCopy,
  findingCount,
  formatBytes,
  formatDate,
  formatElapsed,
  formatSeconds,
  grouped,
  isError,
  isMajor,
  siteName,
  tone,
  verdict,
  type ChangeStatus,
  type Comparison,
  type Tone,
} from "./model"
import { downloadReport } from "./report-download"
import "../session-seo-tab.css"
import type { AuditView } from "./view"

// Muted score colours, like Lighthouse's own bands but calmer on a panel. The number always shows beside the colour.
const TONE_COLOR: Record<Tone, string> = {
  good: "#3f8f6a",
  fair: "#b07a45",
  poor: "#c4483e",
  unknown: "var(--v2-text-text-faint)",
}

const TONE_TEXT: Record<Tone, string> = {
  good: "text-[#3f8f6a]",
  fair: "text-[#b07a45]",
  poor: "text-[#c4483e]",
  unknown: "text-v2-text-text-faint",
}

const SEVERITY_COLOR: Record<Audit.Severity, string> = {
  critical: "#c4483e",
  high: "#d2693f",
  medium: "#c99a3c",
  low: "#5b84c4",
  optional: "#9aa3ae",
  info: "#c3c9d0",
}

const SEVERITY_CLASS: Record<Audit.Severity, string> = {
  critical: "bg-[#c4483e]/12 text-[#c4483e]",
  high: "bg-[#d2693f]/12 text-[#d2693f]",
  medium: "bg-[#c99a3c]/15 text-[#a77a22]",
  low: "bg-[#5b84c4]/12 text-[#4a72b0]",
  optional: "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted",
  info: "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted",
}

type IconName = IconProps["name"]

const CHANGE_ICON: Record<ChangeStatus, IconName> = { fixed: "check-small", remaining: "dash", introduced: "warning" }

const card =
  "flex flex-col gap-4 p-5 rounded-xl border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"

// The brand's navy, the logo's background.
const primary =
  "inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg bg-[#0a3a78] text-[#fff] text-[13px] font-medium cursor-pointer transition-colors hover:bg-[#082f62] disabled:opacity-50 disabled:cursor-default"

// White with black text in either theme, for "Test again".
const light =
  "inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg border border-[#d9dde3] bg-[#fff] text-[#111] text-[13px] font-medium cursor-pointer transition-colors hover:bg-[#f3f4f6] disabled:opacity-50 disabled:cursor-default"

const kicker = "text-12-medium uppercase tracking-[0.08em] text-v2-text-text-muted"

/** The website audit: Lighthouse, the technical analysis and the own checks, with fixes by the agent. */
export function SeoPanel(props: { view: AuditView }) {
  const ctx = useSeo()
  const view = props.view
  const locale = () => ctx.locale.locale()
  const date = (time: number) => formatDate(time, locale())

  const runLabel = () => {
    if (view.running()) return ctx.t("action.running")

    return view.report() ? ctx.t("action.retest") : ctx.t("action.create")
  }

  const step = () => {
    const current = view.state.status.running?.step

    if (current === "preview") return ctx.t("running.preview")

    return ctx.t("running.lighthouse")
  }

  const [making, setMaking] = createSignal(false)

  // Downloads the PDF at once, in the app's language; a failure says why in a toast.
  const download = (report: Audit.Report) => {
    if (making()) return
    setMaking(true)
    void downloadReport(report, { pdf: view.pdf, t: ctx.t, plural: ctx.plural, locale: locale() })
      .catch((error: { readonly message?: string } | undefined) =>
        ctx.toast.show({ variant: "error", title: ctx.t("report.failed", { reason: error?.message ?? "" }) }),
      )
      .finally(() => setMaking(false))
  }

  return (
    <div data-component="tools-seo" class="flex flex-col gap-4 pb-10">
      <div class="flex flex-col gap-1">
        <div class="text-16-medium text-v2-text-text-base">{ctx.t("seo.title")}</div>
        <div class="text-[13px] text-v2-text-text-muted">{ctx.t("seo.description")}</div>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Segmented
            value={view.state.target}
            disabled={view.running() || view.fixActive()}
            options={[
              { value: "preview", label: ctx.t("target.preview") },
              { value: "url", label: ctx.t("target.url") },
            ]}
            onChange={(value) => view.setTarget(value)}
          />
          <Segmented
            value={view.state.formFactor}
            disabled={view.running() || view.fixActive()}
            options={[
              { value: "mobile", label: ctx.t("formFactor.mobile") },
              { value: "desktop", label: ctx.t("formFactor.desktop") },
            ]}
            onChange={(value) => view.setFormFactor(value)}
          />
          <div class="ms-auto flex items-center gap-2">
            <Show when={view.running()}>
              <Button variant="ghost" size="small" onClick={() => view.cancel()}>
                {ctx.t("action.cancel")}
              </Button>
            </Show>
            <button
              type="button"
              class={light}
              data-action="audit-run"
              disabled={view.running() || view.fixActive() || (view.state.target === "url" && !view.state.url.trim())}
              onClick={() => view.run()}
            >
              <Show when={view.running()} fallback={<Icon name="refresh" size="small" />}>
                <Spinner />
              </Show>
              {runLabel()}
            </button>
          </div>
        </div>
        <Show when={view.state.target === "url"}>
          <input
            value={view.state.url}
            onInput={(event) => view.setURL(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && !view.running() && view.run()}
            placeholder={ctx.t("url.placeholder")}
            aria-label={ctx.t("url.label")}
            spellcheck={false}
            inputMode="url"
            class="h-8 px-3 rounded-md border border-v2-border-border-base bg-transparent text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong placeholder:text-v2-text-text-faint"
          />
        </Show>
      </div>

      <Show when={view.state.error ?? view.state.status.error}>
        {(error) => (
          <Note tone="danger" icon="warning">
            {ctx.t("failed", { reason: error() })}
          </Note>
        )}
      </Show>

      <Show when={view.state.status.running}>
        <div class="flex items-center gap-3.5 p-3.5 rounded-lg border border-v2-state-border-info bg-v2-state-bg-info">
          <Spinner large />
          <div class="flex flex-col gap-0.5 min-w-0">
            <b class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("running.title")}</b>
            <span class="text-12-regular text-v2-text-text-muted">{step()}</span>
          </div>
          <span class="ms-auto font-mono text-12-regular tabular-nums text-v2-text-text-muted">
            {formatElapsed(view.auditElapsed())}
          </span>
        </div>
      </Show>

      <Show when={!view.running() && !view.report()}>
        <div class="flex items-start gap-2.5 p-3.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 text-v2-text-text-muted">
          <Icon name="magnifying-glass" />
          <div class="flex flex-col gap-0.5">
            <b class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("empty.title")}</b>
            <span class="text-12-regular leading-[1.5]">{ctx.t("empty.description")}</span>
          </div>
        </div>
      </Show>

      <Show when={view.report()} keyed>
        {(report) => (
          <>
            <Summary
              report={report}
              date={date(report.createdAt)}
              making={making()}
              onReport={() => download(report)}
            />
            <OptimizeCard view={view} report={report} />
            <LighthouseCard view={view} report={report} date={date} />
            <TechnicalCard report={report} />
            <ChecksCard view={view} report={report} />
          </>
        )}
      </Show>

      <Show when={view.state.status.history.length > 0}>
        <History view={view} date={date} />
      </Show>
    </div>
  )
}

function Summary(props: {
  report: Audit.Report
  date: string
  making: boolean
  onReport: () => void
}) {
  const ctx = useSeo()

  return (
    <div class={`${card} @container`}>
      <div class="flex flex-wrap items-center gap-x-5 gap-y-4">
        <Ring score={props.report.score} size={92} stroke={7} label={ctx.t("overall.kicker")}>
          <span class="text-[26px] leading-none font-[600] tabular-nums text-v2-text-text-base">
            {props.report.score}
          </span>
          <span class="text-[11px] text-v2-text-text-faint">/ 100</span>
        </Ring>
        <div class="flex flex-1 min-w-[160px] flex-col gap-1">
          <span class={kicker}>{ctx.t("overall.kicker")}</span>
          <span class="text-[18px] font-[600] text-v2-text-text-base">{ctx.t(verdict(props.report.score))}</span>
          <span class="text-[13px] text-v2-text-text-muted truncate">
            {props.report.preview ? ctx.t("history.preview") : siteName(props.report.url)} · {ctx.t("scanned", { date: props.date })}
          </span>
        </div>
        <div class="flex items-center gap-2 @max-[28rem]:w-full">
          <button
            type="button"
            data-action="audit-report"
            class={`${primary} @max-[28rem]:flex-1`}
            disabled={props.making}
            onClick={() => props.onReport()}
          >
            <Show when={props.making} fallback={<Icon name="download" size="small" />}>
              <Spinner />
            </Show>
            {props.making ? ctx.t("report.making") : ctx.t("action.report")}
          </button>
        </div>
      </div>
    </div>
  )
}

function LighthouseCard(props: { view: AuditView; report: Audit.Report; date: (time: number) => string }) {
  const ctx = useSeo()

  return (
    <div class={card}>
      <div class="flex items-baseline justify-between gap-2">
        <span class={kicker}>{ctx.t("source")}</span>
        <Show when={props.report.lighthouse}>
          {(lighthouse) => (
            <span class="text-12-regular text-v2-text-text-faint">{props.date(Date.parse(lighthouse().fetchTime))}</span>
          )}
        </Show>
      </div>
      <Show
        when={props.report.lighthouse}
        fallback={
          <Note tone="warning" icon="warning">
            {ctx.t("lighthouse.unavailable", { reason: props.report.lighthouseError ?? "" })}
          </Note>
        }
      >
        {(lighthouse) => (
          <>
            <div class="grid grid-cols-[repeat(auto-fit,minmax(84px,1fr))] gap-3 justify-items-center">
              <For each={CATEGORIES}>
                {(category) => (
                  <div class="flex flex-col items-center gap-2">
                    <Ring score={lighthouse().categories[category]} size={78} stroke={6} label={categoryLabel(category, ctx.t)}>
                      <span class={`text-[22px] font-[600] tabular-nums ${TONE_TEXT[tone(lighthouse().categories[category])]}`}>
                        {lighthouse().categories[category] ?? "–"}
                      </span>
                    </Ring>
                    <span class="text-12-medium text-center text-v2-text-text-muted">{ctx.t(`gauge.${category}`)}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={lighthouse().agentic}>
              {(agentic) => (
                <div class="text-[13px] text-v2-text-text-muted">
                  {ctx.t("agentic.passed", { passed: agentic().passed, total: agentic().total })}
                </div>
              )}
            </Show>
            <div class="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-x-4 gap-y-3 py-3 border-y border-v2-border-border-base/70">
              <For each={METRICS}>
                {(metric) => (
                  <Fact
                    label={metric.label.includes(".") ? ctx.t(metric.label) : metric.label}
                    value={lighthouse().metrics[metric.key] ?? "–"}
                  />
                )}
              </For>
            </div>
            <Show when={lighthouse().failed.length > 0}>
              <details class="group rounded-xl bg-v2-overlay-simple-overlay-hover/50">
                <summary class="flex items-center gap-2 px-4 py-3 cursor-pointer select-none text-[13px] font-medium text-v2-text-text-base list-none">
                  <Icon name="chevron-right" size="small" class="transition-transform group-open:rotate-90 text-v2-text-text-muted" />
                  {ctx.t("findings", { count: lighthouse().failed.length })}
                </summary>
                <div class="px-4 pb-2">
                  <For each={lighthouse().failed}>
                    {(finding) => (
                      <Row
                        badge={ctx.t(isError(finding) ? "severity.error" : "severity.warning")}
                        badgeClass={SEVERITY_CLASS[isError(finding) ? "critical" : "medium"]}
                        title={finding.title}
                        detail={finding.display}
                        fix={
                          props.report.preview
                            ? {
                                disabled: !props.view.canFix(),
                                run: () => props.view.fix({ kind: "lighthouse", id: finding.id }),
                              }
                            : undefined
                        }
                      />
                    )}
                  </For>
                </div>
              </details>
            </Show>
            <div class="flex items-center gap-1.5 text-12-regular text-v2-text-text-faint min-w-0">
              <span class="shrink-0">{ctx.t("audited")}</span>
              <code class="font-mono truncate text-v2-text-text-muted">{lighthouse().url}</code>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function TechnicalCard(props: { report: Audit.Report }) {
  const ctx = useSeo()
  const locale = () => ctx.locale.locale()

  const items = (technical: Audit.Technical): { label: string; value: string }[] => [
    { label: ctx.t("technical.status"), value: String(technical.status) },
    { label: ctx.t("technical.loadTime"), value: formatSeconds(technical.loadTime, locale()) },
    { label: ctx.t("technical.https"), value: technical.https ? ctx.t("technical.https.yes") : ctx.t("technical.https.no") },
    ...(technical.country ? [{ label: ctx.t("technical.country"), value: technical.country }] : []),
    ...(technical.cms ? [{ label: ctx.t("technical.cms"), value: technical.cms }] : []),
    ...(technical.server ? [{ label: ctx.t("technical.server"), value: technical.server }] : []),
    { label: ctx.t("technical.ttfb"), value: `${technical.ttfb} ms` },
    { label: ctx.t("technical.size"), value: formatBytes(technical.size, locale()) },
    ...(technical.certificateDays === undefined
      ? []
      : [{ label: ctx.t("technical.certificate"), value: ctx.plural("technical.certificate.days", technical.certificateDays) }]),
    { label: ctx.t("technical.links"), value: String(technical.links) },
  ]

  return (
    <div class={card}>
      <span class={kicker}>{ctx.t("technical.title")}</span>
      <Show
        when={props.report.technical}
        fallback={
          <Note tone="warning" icon="warning">
            {ctx.t("technical.unavailable", { reason: props.report.technicalError ?? "" })}
          </Note>
        }
      >
        {(technical) => (
          <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-6 gap-y-5">
            <For each={items(technical())}>{(item) => <Fact label={item.label} value={item.value} large />}</For>
          </div>
        )}
      </Show>
    </div>
  )
}

function ChecksCard(props: { view: AuditView; report: Audit.Report }) {
  const ctx = useSeo()

  return (
    <div class={card}>
      <div class="flex flex-col gap-0.5">
        <span class={kicker}>{ctx.t("checks.title")}</span>
        <span class="text-12-regular text-v2-text-text-muted">
          <Show when={props.report.checks.length > 0} fallback={ctx.t("checks.none")}>
            {ctx.plural("checks.summary", props.report.checks.length, {
              major: props.report.checks.filter(isMajor).length,
            })}
          </Show>
        </span>
      </div>
      <Show when={props.report.checks.length > 0}>
        <SeverityBar checks={props.report.checks} />
      </Show>
      <For each={grouped(props.report.checks)}>
        {(entry) => (
          <div class="flex flex-col">
            <div class="flex items-center gap-1.5 pb-1.5 border-b border-v2-border-border-strong">
              <span class="text-12-medium text-v2-text-text-base">{ctx.t(`group.${entry.group}`)}</span>
              <span class="min-w-4 px-1 rounded-full bg-v2-text-text-base text-v2-background-bg-base text-[10px] font-medium text-center">
                {entry.items.length}
              </span>
            </div>
            <For each={entry.items}>
              {(check) => {
                const copy = () => checkCopy(check, ctx.t)

                return (
                  <Row
                    badge={ctx.t(`severity.${check.severity}`)}
                    badgeClass={SEVERITY_CLASS[check.severity]}
                    title={copy().title}
                    detail={copy().detail}
                    fix={
                      props.report.preview
                        ? { disabled: !props.view.canFix(), run: () => props.view.fix({ kind: "check", id: check.id }) }
                        : undefined
                    }
                  />
                )
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}

function OptimizeCard(props: { view: AuditView; report: Audit.Report }) {
  const ctx = useSeo()
  const fix = () => props.view.state.fix
  const count = () => findingCount(props.report, undefined)

  return (
    <div class="@container flex flex-col gap-4 p-5 rounded-xl border border-[#0a3a78]/25 bg-[#0a3a78]/[0.05]">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span class="flex shrink-0 items-center justify-center size-10 rounded-xl bg-[#0a3a78] text-[#fff]">
          <Icon name="brain" />
        </span>
        <div class="flex flex-1 min-w-[180px] flex-col gap-0.5">
          <div class="text-16-medium text-v2-text-text-base">{ctx.t("optimize.title")}</div>
          <div class="text-[13px] leading-[1.5] text-v2-text-text-muted">
            {ctx.plural("optimize.issueCount", count())} · {ctx.t("optimize.description")}
          </div>
        </div>
        <Show when={!props.view.fixActive()}>
          <button
            type="button"
            class={`${primary} h-10 px-5 text-14-medium shadow-[0_1px_2px_rgb(10_58_120/0.3)] @max-[28rem]:w-full`}
            data-action="audit-fix-all"
            disabled={!props.view.canFix() || count() === 0}
            onClick={() => props.view.fix()}
          >
            <Icon name="brain" size="small" />
            {ctx.t("optimize.all")}
          </button>
        </Show>
      </div>

      <Show when={props.view.fixActive()}>
        <div class="flex items-center gap-3 p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01">
          <Spinner large />
          <div class="flex flex-col gap-0.5 min-w-0">
            <b class="text-[13px] font-medium text-v2-text-text-base">
              {fix().phase === "auditing" ? ctx.t("optimize.auditing") : ctx.t("optimize.working")}
            </b>
            <span class="text-12-regular text-v2-text-text-muted">
              {fix().target
                ? ctx.t("optimize.workingOne")
                : ctx.plural("optimize.workingAll", findingCount(fix().baseline ?? props.report, undefined))}
            </span>
          </div>
          <span class="ms-auto font-mono text-12-regular tabular-nums text-v2-text-text-muted">
            {formatElapsed(props.view.elapsed())}
          </span>
          <Show when={fix().phase !== "auditing"}>
            <Button variant="secondary" size="small" icon="stop" onClick={() => props.view.stopFix()}>
              {ctx.t("optimize.stop")}
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={fix().phase === "stopped"}>
        <Note tone="warning" icon="warning">
          {ctx.t("optimize.stopped")}
        </Note>
      </Show>
      <Show when={fix().phase === "error" && fix().error}>
        {(error) => (
          <Note tone="danger" icon="warning">
            {error()}
          </Note>
        )}
      </Show>

      <Show when={!props.view.fixActive()}>
        <div class="empty:hidden">
          <Switch>
            <Match when={!props.report.preview}>
              <span class="text-12-regular text-v2-state-fg-warning">{ctx.t("optimize.website")}</span>
            </Match>
            <Match when={props.view.agentBusy()}>
              <span class="text-12-regular text-v2-state-fg-warning">{ctx.t("optimize.agentBusy")}</span>
            </Match>
          </Switch>
        </div>
      </Show>

      <Show when={fix().phase === "done" && fix().comparison}>
        {(comparison) => (
          <Result
            comparison={comparison()}
            canRetry={props.view.canFix()}
            onRetry={() => props.view.fix(fix().target)}
            onDismiss={() => props.view.dismissFix()}
          />
        )}
      </Show>
    </div>
  )
}

function Result(props: { comparison: Comparison; canRetry: boolean; onRetry: () => void; onDismiss: () => void }) {
  const ctx = useSeo()
  const delta = (value: number | null) => (value === null ? "–" : value > 0 ? `+${value}` : String(value))

  const deltaClass = (value: number | null) =>
    value === null || value === 0 ? "text-v2-text-text-faint" : value > 0 ? TONE_TEXT.good : TONE_TEXT.poor

  const rows = () => [
    {
      label: ctx.t("optimize.overall"),
      before: props.comparison.overall.before,
      after: props.comparison.overall.after,
      delta: props.comparison.overall.after - props.comparison.overall.before,
    },
    ...props.comparison.categories.map((item) => ({ label: categoryLabel(item.category, ctx.t), ...item })),
  ]

  return (
    <div class="flex flex-col gap-3 pt-3.5 border-t border-v2-border-border-base">
      <div class="flex flex-col gap-1">
        <span class={kicker}>{ctx.t("optimize.result.title")}</span>
        <span class={`text-[13px] font-medium ${props.comparison.improved ? TONE_TEXT.good : "text-v2-text-text-base"}`}>
          {props.comparison.fixed === 0 && !props.comparison.improved
            ? ctx.t("optimize.result.noProgress")
            : ctx.t("optimize.result.summary", { fixed: props.comparison.fixed, total: props.comparison.total })}
        </span>
      </div>
      <div class="flex flex-col gap-1">
        <For each={rows()}>
          {(row) => (
            <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 px-2.5 py-1.5 rounded-md bg-v2-background-bg-layer-01 text-12-regular">
              <span class="text-v2-text-text-muted">{row.label}</span>
              <span class="flex items-center gap-1 tabular-nums text-v2-text-text-base">
                {row.before ?? "–"}
                <Icon name="arrow-right" size="small" class="text-v2-text-text-faint" />
                {row.after ?? "–"}
              </span>
              <span class={`min-w-8 text-end font-[600] tabular-nums ${deltaClass(row.delta)}`}>{delta(row.delta)}</span>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-col gap-1">
        <For each={props.comparison.changes}>
          {(change) => (
            <div class="flex items-center gap-2 text-12-regular min-w-0">
              <span
                class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                classList={{
                  "bg-v2-state-bg-success text-v2-state-fg-success": change.status === "fixed",
                  "bg-v2-state-bg-warning text-v2-state-fg-warning": change.status === "remaining",
                  "bg-v2-state-bg-danger text-v2-state-fg-danger": change.status === "introduced",
                }}
              >
                <Icon
                  name={CHANGE_ICON[change.status]}
                  size="small"
                />
                {ctx.t(`optimize.change.${change.status}`)}
              </span>
              <span class="truncate text-v2-text-text-base">{change.title}</span>
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="small" icon="refresh" disabled={!props.canRetry} onClick={() => props.onRetry()}>
          {ctx.t("optimize.result.retry")}
        </Button>
        <Button variant="ghost" size="small" onClick={() => props.onDismiss()}>
          {ctx.t("optimize.result.dismiss")}
        </Button>
      </div>
    </div>
  )
}

function History(props: { view: AuditView; date: (time: number) => string }) {
  const ctx = useSeo()

  return (
    <div class="flex flex-col gap-1.5">
      <span class={kicker}>{ctx.t("history.title")}</span>
      <Show when={props.view.state.status.history.length > 1}>
        <Trend items={props.view.state.status.history} date={props.date} />
      </Show>
      <div class="flex flex-col rounded-xl border border-v2-border-border-base overflow-hidden">
        <For each={props.view.state.status.history}>
          {(item) => (
            <div
              class="group flex items-center gap-2.5 px-3 py-2 border-t border-v2-border-border-base first:border-t-0 hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-v2-overlay-simple-overlay-hover": props.view.report()?.id === item.id }}
            >
              <button
                type="button"
                class="flex flex-1 min-w-0 items-center gap-2.5 text-start cursor-pointer"
                onClick={() => props.view.open(item.id)}
              >
                <span class={`w-8 text-14-medium tabular-nums ${TONE_TEXT[tone(item.score)]}`}>{item.score}</span>
                <span class="flex flex-col min-w-0">
                  <span class="text-12-medium text-v2-text-text-base truncate">
                    {item.preview ? ctx.t("history.preview") : siteName(item.url)}
                  </span>
                  <span class="text-[11px] text-v2-text-text-faint truncate">
                    {props.date(item.createdAt)} · {ctx.t(`formFactor.${item.formFactor}`)}
                  </span>
                </span>
              </button>
              <Tooltip value={ctx.t("history.remove")} placement="left">
                <button
                  type="button"
                  aria-label={ctx.t("history.remove")}
                  class="shrink-0 flex items-center justify-center size-6 rounded-md cursor-pointer text-v2-text-text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                  onClick={() => props.view.remove(item.id)}
                >
                  <Icon name="trash" size="small" />
                </button>
              </Tooltip>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function Row(props: {
  badge: string
  badgeClass: string
  title: string
  detail?: string
  fix?: { disabled: boolean; run: () => void }
}) {
  const ctx = useSeo()

  return (
    <div class="flex flex-col gap-1 py-2.5 border-t border-v2-border-border-base first:border-t-0">
      <div class="flex items-baseline gap-2">
        <span class={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.04em] ${props.badgeClass}`}>
          {props.badge}
        </span>
        <span class="flex-1 min-w-0 text-12-medium text-v2-text-text-base">{props.title}</span>
        <Show when={props.fix}>
          {(fix) => (
            <button
              type="button"
              disabled={fix().disabled}
              onClick={() => fix().run()}
              class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-v2-border-border-base text-[11px] font-medium text-v2-text-text-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-45 disabled:cursor-default"
            >
              <Icon name="arrow-up" size="small" />
              {ctx.t("optimize.fixOne")}
            </button>
          )}
        </Show>
      </div>
      <Show when={props.detail}>
        <div class="text-12-regular leading-[1.5] text-v2-text-text-muted break-words">{props.detail}</div>
      </Show>
    </div>
  )
}

/** A score ring: the arc fills to the score in its band's colour, with the score itself inside. */
function Ring(props: { score: number | null; size: number; stroke: number; label: string; children: JSX.Element }) {
  const radius = () => (props.size - props.stroke) / 2
  const circumference = () => 2 * Math.PI * radius()
  const dash = () => ((props.score ?? 0) / 100) * circumference()

  return (
    <div
      class="relative shrink-0"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      role="img"
      aria-label={`${props.label}: ${props.score ?? "–"} / 100`}
    >
      <svg viewBox={`0 0 ${props.size} ${props.size}`} width={props.size} height={props.size} class="-rotate-90">
        <circle
          cx={props.size / 2}
          cy={props.size / 2}
          r={radius()}
          fill="none"
          stroke-width={props.stroke}
          class="stroke-v2-border-border-base/60"
        />
        <Show when={props.score !== null}>
          <circle
            cx={props.size / 2}
            cy={props.size / 2}
            r={radius()}
            fill="none"
            stroke={TONE_COLOR[tone(props.score)]}
            stroke-width={props.stroke}
            stroke-linecap="round"
            stroke-dasharray={`${dash().toFixed(1)} ${(circumference() - dash()).toFixed(1)}`}
            class="transition-[stroke-dasharray] duration-700 motion-reduce:transition-none"
          />
        </Show>
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center">{props.children}</div>
    </div>
  )
}

function Fact(props: { label: string; value: string; large?: boolean }) {
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-12-regular text-v2-text-text-muted truncate">{props.label}</span>
      <b class="text-v2-text-text-base truncate font-medium" classList={{ "text-[15px] font-medium": props.large, "text-14-medium": !props.large }}>
        {props.value}
      </b>
    </div>
  )
}

/** How the own findings split by severity: one stacked bar with a labelled legend. */
function SeverityBar(props: { checks: readonly Audit.Check[] }) {
  const ctx = useSeo()

  const counts = () =>
    SEVERITIES.flatMap((severity) => {
      const count = props.checks.filter((check) => check.severity === severity).length

      return count > 0 ? [{ severity, count }] : []
    })

  return (
    <div class="flex flex-col gap-2">
      <div class="flex h-2.5 gap-0.5 rounded-full overflow-hidden" role="img" aria-label={ctx.t("checks.title")}>
        <For each={counts()}>
          {(item) => (
            <div
              class="h-full first:rounded-s-full last:rounded-e-full"
              style={{ "flex-grow": item.count, background: SEVERITY_COLOR[item.severity] }}
              title={`${ctx.t(`severity.${item.severity}`)}: ${item.count}`}
            />
          )}
        </For>
      </div>
      <div class="flex flex-wrap gap-x-3.5 gap-y-1">
        <For each={counts()}>
          {(item) => (
            <span class="inline-flex items-center gap-1.5 text-12-regular text-v2-text-text-muted">
              <span class="size-2 rounded-full" style={{ background: SEVERITY_COLOR[item.severity] }} />
              {ctx.t(`severity.${item.severity}`)}
              <b class="font-medium tabular-nums text-v2-text-text-base">{item.count}</b>
            </span>
          )}
        </For>
      </div>
    </div>
  )
}

/** The overall score of the kept reports over time, oldest on the left; hovering a point names its scan. */
function Trend(props: { items: readonly Audit.Report[]; date: (time: number) => string }) {
  const ctx = useSeo()
  const width = 320
  const height = 64
  const pad = 6

  const points = () => {
    const items = props.items.toReversed()
    const step = (width - pad * 2) / Math.max(1, items.length - 1)

    return items.map((item, index) => ({
      item,
      x: pad + index * step,
      y: pad + ((100 - item.score) / 100) * (height - pad * 2),
    }))
  }

  const line = () => points().map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")

  return (
    <div class="rounded-xl border border-v2-border-border-base/70 px-3 py-2.5">
      <svg viewBox={`0 0 ${width} ${height}`} class="w-full h-16 overflow-visible" role="img" aria-label={ctx.t("history.title")}>
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} class="stroke-v2-border-border-base" stroke-dasharray="2 4" />
        <path d={line()} fill="none" stroke="#0a3a78" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <For each={points()}>
          {(point) => (
            <g>
              <title>{`${props.date(point.item.createdAt)} · ${point.item.score}`}</title>
              <circle cx={point.x} cy={point.y} r="10" fill="transparent" />
              <circle cx={point.x} cy={point.y} r="4" fill={TONE_COLOR[tone(point.item.score)]} class="stroke-v2-background-bg-layer-01" stroke-width="2" />
            </g>
          )}
        </For>
      </svg>
    </div>
  )
}

function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <div class="flex gap-0.5 p-0.5 rounded-lg bg-v2-overlay-simple-overlay-hover">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            aria-pressed={props.value === option.value}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            class="px-3 py-1 rounded-md text-12-regular cursor-pointer transition-colors disabled:cursor-default disabled:opacity-60"
            classList={{
              "bg-v2-background-bg-layer-01 text-v2-text-text-base font-medium shadow-[0_1px_2px_rgb(0_0_0/0.08)]": props.value === option.value,
              "text-v2-text-text-muted hover:text-v2-text-text-base": props.value !== option.value,
            }}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

function Note(props: { tone: "danger" | "warning"; icon: "warning"; children: JSX.Element }) {
  return (
    <div
      class="flex items-start gap-2 px-3 py-2.5 rounded-lg text-12-regular"
      classList={{
        "bg-v2-state-bg-danger text-v2-state-fg-danger": props.tone === "danger",
        "bg-v2-state-bg-warning text-v2-state-fg-warning": props.tone === "warning",
      }}
    >
      <Icon name={props.icon} size="small" class="shrink-0 mt-px" />
      <span class="min-w-0 break-words">{props.children}</span>
    </div>
  )
}

function Spinner(props: { large?: boolean }) {
  return <span class="session-seo-spinner" classList={{ lg: props.large }} />
}
