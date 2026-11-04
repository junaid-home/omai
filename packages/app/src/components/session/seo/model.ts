// What the website audit panel and its PDF derive from a report: tones, verdicts, the grouped checks, the prompts that
// ask the agent to fix findings, and what changed between two reports.

import type { Audit } from "./types"

export type Translate = (key: string, params?: Record<string, string | number>) => string

export type Plural = (key: string, count: number, params?: Record<string, string | number>) => string

export const CATEGORIES: readonly Audit.Category[] = ["performance", "accessibility", "bestPractices", "seo", "agentic"]

export const GROUPS: readonly Audit.Group[] = ["reachability", "geo", "agentic", "design", "technical"]

export const SEVERITIES: readonly Audit.Severity[] = ["critical", "high", "medium", "low", "optional", "info"]

export const METRICS: ReadonlyArray<{ key: keyof Audit.Metrics; label: string }> = [
  { key: "fcp", label: "FCP" },
  { key: "lcp", label: "LCP" },
  { key: "tbt", label: "TBT" },
  { key: "cls", label: "CLS" },
  { key: "si", label: "metric.speedIndex" },
]

export type Tone = "good" | "fair" | "poor" | "unknown"

/** Lighthouse's own colour bands. */
export function tone(score: number | null | undefined): Tone {
  if (score === null || score === undefined) return "unknown"

  if (score >= 90) return "good"

  if (score >= 50) return "fair"

  return "poor"
}

/** The copy key for the overall score's verdict. */
export function verdict(score: number) {
  if (score >= 90) return "verdict.excellent"

  if (score >= 75) return "verdict.good"

  if (score >= 50) return "verdict.fair"

  return "verdict.poor"
}

/** The copy key for one category's rating in the PDF. */
export function rating(score: number | null) {
  if (score === null || score < 50) return "rating.critical"

  if (score < 90) return "rating.improve"

  return "rating.good"
}

/** Whether a Lighthouse finding counts as an error rather than a warning. */
export const isError = (finding: Audit.Finding) => (finding.score ?? 1) < 0.5

/** A check's significance: critical, high and medium findings count in the summary. */
export const isMajor = (check: Audit.Check) => ["critical", "high", "medium"].includes(check.severity)

/** The checks of each group in severity order, without empty groups. */
export function grouped(checks: readonly Audit.Check[]) {
  return GROUPS.flatMap((group) => {
    const items = checks
      .filter((check) => check.group === group)
      .toSorted((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))

    return items.length > 0 ? [{ group, items }] : []
  })
}

/** A check's title and detail in the user's language. */
export function checkCopy(check: Audit.Check, t: Translate) {
  const values = check.values ?? {}

  return { title: t(`check.${check.id}.title`, values), detail: t(`check.${check.id}.detail`, values) }
}

export const categoryLabel = (category: Audit.Category, t: Translate) =>
  category === "agentic" ? t("category.agentic") : t(`gauge.${category}`)

/** A finding the agent can be asked to fix. */
export type Target = { kind: "lighthouse"; id: string } | { kind: "check"; id: string }

const RULES = [
  "- Fix the real cause in the project's source code. Do not hide or fake the result.",
  "- Keep the app working and consistent after your changes.",
  "- Only report a finding as solved when you actually made the change that solves it. No change means no claim.",
  "- Some fixes involve trade-offs (for example a smaller hero image versus visual quality). When a fix is not worth it, say so and move on instead of forcing it.",
  "- When you are done, list which findings you believe are now resolved and which are still open, and why.",
]

/** The prompt that asks the agent to fix every finding of a report, or one. */
export function fixPrompt(report: Audit.Report, target: Target | undefined, t: Translate) {
  const scores = CATEGORIES.map((category) => {
    const score = report.lighthouse?.categories[category]

    return `${categoryLabel(category, t)}: ${score === null || score === undefined ? "not scored" : score}`
  })

  const lighthouse = (report.lighthouse?.failed ?? []).filter(
    (finding) => !target || (target.kind === "lighthouse" && target.id === finding.id),
  )

  const checks = report.checks.filter((check) => !target || (target.kind === "check" && target.id === check.id))

  const lines = [
    ...lighthouse.map((finding) => `${finding.title} (Lighthouse: ${finding.id})${finding.display ? ` — ${finding.display}` : ""}`),
    ...checks.map((check) => {
      const copy = checkCopy(check, t)

      return `${copy.title} (check: ${check.id}, ${check.severity}) — ${copy.detail}`
    }),
  ]

  return [
    target
      ? `Fix a single website audit finding for this project (${report.formFactor}).`
      : `Improve the website audit results for this project (${report.formFactor}) as far as is realistically achievable.`,
    "",
    "Current Lighthouse scores:",
    ...scores,
    "",
    target ? "Finding to fix:" : `Findings (${lines.length}):`,
    ...lines.map((line, index) => `${index + 1}. ${line}`),
    "",
    target
      ? "Target only this finding; do not refactor unrelated code."
      : "Work through every finding above and implement the fixes in the project.",
    ...RULES,
  ].join("\n")
}

/** How many findings a fix of `target` covers. */
export const findingCount = (report: Audit.Report, target: Target | undefined) =>
  target ? 1 : (report.lighthouse?.failed.length ?? 0) + report.checks.length

export type ChangeStatus = "fixed" | "remaining" | "introduced"

export interface Comparison {
  overall: { before: number; after: number }
  categories: { category: Audit.Category; before: number | null; after: number | null; delta: number | null }[]
  changes: { title: string; status: ChangeStatus }[]
  fixed: number
  total: number
  improved: boolean
}

/** What changed between the report before the fixes and the one after, for the findings the fix targeted. */
export function compare(before: Audit.Report, after: Audit.Report, target: Target | undefined, t: Translate): Comparison {
  const findings = (report: Audit.Report) => [
    ...(report.lighthouse?.failed ?? []).map((finding) => ({ key: `lighthouse:${finding.id}`, title: finding.title })),
    ...report.checks.map((check) => ({ key: `check:${check.id}`, title: checkCopy(check, t).title })),
  ]

  const wanted = (key: string) => !target || key === `${target.kind}:${target.id}`
  const was = findings(before).filter((finding) => wanted(finding.key))
  const now = findings(after)
  const nowKeys = new Set(now.map((finding) => finding.key))
  const wasKeys = new Set(findings(before).map((finding) => finding.key))

  const changes: Comparison["changes"] = [
    ...was.map((finding) => ({ title: finding.title, status: nowKeys.has(finding.key) ? "remaining" : "fixed" }) as const),
    ...(target ? [] : now.filter((finding) => !wasKeys.has(finding.key))).map(
      (finding) => ({ title: finding.title, status: "introduced" }) as const,
    ),
  ]

  const categories = CATEGORIES.map((category) => {
    const from = before.lighthouse?.categories[category] ?? null
    const to = after.lighthouse?.categories[category] ?? null

    return { category, before: from, after: to, delta: from === null || to === null ? null : to - from }
  })

  const fixed = changes.filter((change) => change.status === "fixed").length

  return {
    overall: { before: before.score, after: after.score },
    categories,
    changes,
    fixed,
    total: was.length,
    improved: after.score > before.score || fixed > 0,
  }
}

export function formatBytes(bytes: number, locale: string) {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })

  if (bytes < 1024) return `${format.format(bytes)} B`

  if (bytes < 1024 * 1024) return `${format.format(Math.round(bytes / 1024))} KB`

  return `${format.format(bytes / 1024 / 1024)} MB`
}

export const formatSeconds = (ms: number, locale: string) =>
  `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ms / 1000)} s`

export const formatDate = (time: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(time)

export const formatElapsed = (ms: number) => {
  const total = Math.floor(ms / 1000)

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** The address a report names without its scheme, like "www.example.com". */
export const siteName = (url: string) => URL.parse(url)?.host ?? url

/** The report's number, like "20261103-95662": its date and five digits of its id. */
export function reportNumber(report: Audit.Report) {
  const date = new Date(report.createdAt)
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
  const digits = Array.from(report.id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 100_000, 7)

  return `${day}-${String(digits).padStart(5, "0")}`
}
