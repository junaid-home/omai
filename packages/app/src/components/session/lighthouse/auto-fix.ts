import type { LighthouseFormFactor, LighthouseResult } from "./types"

export const seoCategoryKeys = ["performance", "accessibility", "best_practices", "seo", "agentic_browsing"] as const
export const seoCategoryNames: Record<SeoCategoryKey, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  best_practices: "Best Practices",
  seo: "SEO",
  agentic_browsing: "Agentic Browsing",
}

export type SeoCategoryKey = (typeof seoCategoryKeys)[number]

export type SeoCategoryDelta = {
  key: SeoCategoryKey
  before: number | null
  after: number | null
  delta: number | null
}

export type SeoFindingStatus = "fixed" | "remaining" | "introduced"

export type SeoFindingChange = {
  finding: LighthouseResult["failed"][number]
  status: SeoFindingStatus
}

export type SeoComparison = {
  categories: SeoCategoryDelta[]
  changes: SeoFindingChange[]
  fixed: number
  remaining: number
  introduced: number
  totalBefore: number
  averageDelta: number | null
  improved: boolean
}

const targetFindings = (result: LighthouseResult, ids: string[]) => {
  if (ids.length === 0) return []
  const wanted = new Set(ids)
  return result.failed.filter((finding) => wanted.has(finding.id))
}

const scoreLine = (result: LighthouseResult, key: SeoCategoryKey) => {
  const value = result.categories[key]
  return `${seoCategoryNames[key]}: ${value === null ? "not scored" : Math.round(value)}`
}

const auditList = (findings: LighthouseResult["failed"]) =>
  findings.length === 0
    ? "No failed audits were reported in the last Lighthouse run."
    : findings
        .map((finding, index) => {
          const detail = finding.display ? ` — ${finding.display}` : ""
          return `${index + 1}. ${finding.title} (${finding.id})${detail}`
        })
        .join("\n")

const sharedRules = [
  "- Fix the real cause in the project's source code. Do not hide or fake the result.",
  "- Keep the app working and consistent after your changes.",
  "- Only report an audit as solved when you actually made the change that solves it. No change means no claim.",
  "- Some fixes involve trade-offs (for example a smaller hero image versus visual quality). When a fix is not worth it, say so and move on instead of forcing it.",
  "- When you are done, list which audits you believe are now resolved and which are still open, and why.",
]

export function buildFixPrompt(result: LighthouseResult, formFactor: LighthouseFormFactor) {
  const categories = seoCategoryKeys.map((key) => scoreLine(result, key)).join("\n")
  const findings = result.failed
  return [
    `Improve the Lighthouse scores for this project (${formFactor}) as far as is realistically achievable.`,
    "",
    "Current scores:",
    categories,
    "",
    `Failed audits (${findings.length}):`,
    auditList(findings),
    "",
    "Work through every failed audit above and implement the fixes in the project.",
    ...sharedRules,
  ].join("\n")
}

export function buildFindingPrompt(result: LighthouseResult, findingID: string, formFactor: LighthouseFormFactor) {
  const [finding] = targetFindings(result, [findingID])
  if (!finding) return buildFixPrompt(result, formFactor)
  const categories = seoCategoryKeys.map((key) => scoreLine(result, key)).join("\n")
  return [
    `Fix a single Lighthouse audit for this project (${formFactor}).`,
    "",
    "Current scores:",
    categories,
    "",
    `Audit to fix: ${finding.title} (${finding.id})${finding.display ? ` — ${finding.display}` : ""}`,
    "Target only this audit; do not refactor unrelated code.",
    ...sharedRules,
  ].join("\n")
}

export function compareResults(before: LighthouseResult, after: LighthouseResult): SeoComparison {
  const categories = seoCategoryKeys.map((key) => {
    const from = before.categories[key]
    const to = after.categories[key]
    return {
      key,
      before: from,
      after: to,
      delta: from === null || to === null ? null : to - from,
    } satisfies SeoCategoryDelta
  })

  const beforeIDs = new Set(before.failed.map((finding) => finding.id))
  const afterIDs = new Set(after.failed.map((finding) => finding.id))
  const changes = [
    ...before.failed.map((finding) => ({
      finding,
      status: (afterIDs.has(finding.id) ? "remaining" : "fixed") as SeoFindingStatus,
    })),
    ...after.failed
      .filter((finding) => !beforeIDs.has(finding.id))
      .map((finding) => ({ finding, status: "introduced" as SeoFindingStatus })),
  ]

  const deltas = categories.map((category) => category.delta).filter((delta): delta is number => delta !== null)
  const averageDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : null

  return {
    categories,
    changes,
    fixed: changes.filter((change) => change.status === "fixed").length,
    remaining: changes.filter((change) => change.status === "remaining").length,
    introduced: changes.filter((change) => change.status === "introduced").length,
    totalBefore: before.failed.length,
    averageDelta,
    improved: (averageDelta ?? 0) > 0,
  }
}
