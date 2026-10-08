import { describe, expect, test } from "bun:test"
import type { LighthouseFinding, LighthouseResult } from "./types"
import { buildFindingPrompt, buildFixPrompt, compareResults } from "./auto-fix"

const finding = (id: string, overrides: Partial<LighthouseFinding> = {}): LighthouseFinding => ({
  id,
  title: id,
  display: "",
  score: 0,
  ...overrides,
})

const result = (overrides: Partial<LighthouseResult> = {}): LighthouseResult => ({
  url: "http://localhost:3000",
  fetch_time: "2026-01-01T00:00:00.000Z",
  categories: {
    performance: 50,
    accessibility: 60,
    best_practices: 70,
    seo: 80,
    agentic_browsing: 90,
  },
  metrics: { fcp: null, lcp: null, tbt: null, cls: null, si: null },
  failed: [],
  agentic_browsing: null,
  ...overrides,
})

describe("compareResults", () => {
  test("marks findings that disappear as fixed and keeps the rest", () => {
    const comparison = compareResults(
      result({ failed: [finding("a"), finding("b")] }),
      result({ failed: [finding("b")] }),
    )
    expect(comparison.fixed).toBe(1)
    expect(comparison.remaining).toBe(1)
    expect(comparison.introduced).toBe(0)
    expect(comparison.changes.map((change) => [change.finding.id, change.status])).toEqual([
      ["a", "fixed"],
      ["b", "remaining"],
    ])
  })

  test("reports newly failing audits as introduced without hiding others", () => {
    const comparison = compareResults(result({ failed: [finding("a")] }), result({ failed: [finding("c")] }))
    expect(comparison.fixed).toBe(1)
    expect(comparison.introduced).toBe(1)
    expect(comparison.changes.find((change) => change.finding.id === "c")?.status).toBe("introduced")
  })

  test("computes per-category deltas and an average", () => {
    const comparison = compareResults(
      result({
        categories: { performance: 40, accessibility: 50, best_practices: null, seo: 60, agentic_browsing: 70 },
      }),
      result({ categories: { performance: 60, accessibility: 50, best_practices: 55, seo: 60, agentic_browsing: 90 } }),
    )
    expect(comparison.categories.find((category) => category.key === "performance")?.delta).toBe(20)
    expect(comparison.categories.find((category) => category.key === "best_practices")?.delta).toBeNull()
    expect(comparison.averageDelta).toBe(10)
    expect(comparison.improved).toBe(true)
  })

  test("does not claim improvement when scores drop", () => {
    const comparison = compareResults(
      result(),
      result({
        categories: {
          performance: 30,
          accessibility: 30,
          best_practices: 30,
          seo: 30,
          agentic_browsing: 30,
        },
      }),
    )
    expect(comparison.improved).toBe(false)
    expect(comparison.averageDelta).toBe(-40)
  })
})

describe("prompt builders", () => {
  test("lists categories and every failed audit", () => {
    const prompt = buildFixPrompt(
      result({ failed: [finding("lcp", { title: "Largest Contentful Paint", display: "3.2 s" })] }),
      "mobile",
    )
    expect(prompt).toContain("Performance: 50")
    expect(prompt).toContain("Largest Contentful Paint (lcp)")
    expect(prompt).toContain("3.2 s")
    expect(prompt).toContain("mobile")
  })

  test("targeted prompt scopes to one audit", () => {
    const prompt = buildFindingPrompt(result({ failed: [finding("a"), finding("b")] }), "b", "desktop")
    expect(prompt).toContain("(b)")
    expect(prompt).not.toContain("(a)")
  })

  test("targeted prompt falls back to the full list for an unknown audit", () => {
    const prompt = buildFindingPrompt(result({ failed: [finding("a")] }), "missing", "mobile")
    expect(prompt).toContain("(a)")
  })
})
