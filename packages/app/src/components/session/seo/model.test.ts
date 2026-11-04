import { describe, expect, test } from "bun:test"
import type { Audit } from "./types"
import { compare, fixPrompt, grouped, reportNumber, verdict } from "./model"

const t = (key: string, params: Record<string, string | number> = {}) =>
  `${key}${Object.keys(params).length ? JSON.stringify(params) : ""}`

const report = (input: Partial<Audit.Report> & Pick<Audit.Report, "id">): Audit.Report => ({
  url: "http://127.0.0.1:3000/",
  preview: true,
  formFactor: "mobile",
  locale: "en-US",
  createdAt: Date.UTC(2026, 10, 3, 15, 42),
  score: 50,
  checks: [],
  ...input,
})

const lighthouse = (failed: string[], performance: number): Audit.Lighthouse => ({
  url: "http://127.0.0.1:3000/",
  fetchTime: "2026-11-03T15:42:00.000Z",
  categories: { performance, accessibility: 80, bestPractices: 90, seo: 90, agentic: 100 },
  metrics: { fcp: null, lcp: null, tbt: null, cls: null, si: null },
  failed: failed.map((id) => ({ id, title: id, display: "", score: 0 })),
  agentic: null,
})

describe("compare", () => {
  test("names what the fixes resolved, what remains and what is new", () => {
    const before = report({
      id: "a",
      score: 50,
      lighthouse: lighthouse(["lcp", "image-alt"], 40),
      checks: [{ id: "no-favicon", group: "design", severity: "low" }],
    })

    const after = report({ id: "b", score: 70, lighthouse: lighthouse(["lcp", "font-display"], 60), checks: [] })
    const result = compare(before, after, undefined, t)

    expect(result.changes.map((change) => [change.status, change.title])).toEqual([
      ["remaining", "lcp"],
      ["fixed", "image-alt"],
      ["fixed", "check.no-favicon.title"],
      ["introduced", "font-display"],
    ])
    expect(result).toMatchObject({ fixed: 2, total: 3, improved: true, overall: { before: 50, after: 70 } })
    expect(result.categories[0]).toEqual({ category: "performance", before: 40, after: 60, delta: 20 })
  })

  test("a single fix only reports that finding", () => {
    const before = report({ id: "a", lighthouse: lighthouse(["lcp", "image-alt"], 40) })
    const after = report({ id: "b", lighthouse: lighthouse(["lcp", "font-display"], 40) })

    expect(compare(before, after, { kind: "lighthouse", id: "image-alt" }, t).changes).toEqual([
      { title: "image-alt", status: "fixed" },
    ])
  })
})

describe("fixPrompt", () => {
  test("lists every finding, or only the one asked for", () => {
    const current = report({
      id: "a",
      lighthouse: lighthouse(["lcp"], 40),
      checks: [{ id: "no-viewport", group: "design", severity: "high" }],
    })

    expect(fixPrompt(current, undefined, t)).toContain("Findings (2):")
    expect(fixPrompt(current, { kind: "check", id: "no-viewport" }, t)).not.toContain("Lighthouse: lcp")
  })
})

test("grouped keeps the group order and puts the worst first", () => {
  const groups = grouped([
    { id: "no-csp", group: "technical", severity: "medium" },
    { id: "no-https", group: "technical", severity: "critical" },
    { id: "broken-links", group: "reachability", severity: "medium" },
  ])

  expect(groups.map((entry) => [entry.group, entry.items.map((item) => item.id)])).toEqual([
    ["reachability", ["broken-links"]],
    ["technical", ["no-https", "no-csp"]],
  ])
})

test("verdict and report number", () => {
  expect([verdict(95), verdict(80), verdict(60), verdict(20)]).toEqual([
    "verdict.excellent",
    "verdict.good",
    "verdict.fair",
    "verdict.poor",
  ])
  expect(reportNumber(report({ id: "x" }))).toMatch(/^20261103-\d{5}$/)
})
