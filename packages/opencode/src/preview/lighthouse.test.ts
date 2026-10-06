import { describe, expect, test } from "bun:test"
import { auditPreview, mapResult, resolveLighthouseBin, type Lhr } from "./lighthouse"

describe("preview lighthouse", () => {
  test("resolves a runnable lighthouse binary", () => {
    expect(resolveLighthouseBin().length).toBeGreaterThan(0)
  })

  test("refuses to audit a preview that is not running", async () => {
    let message = ""
    try {
      await auditPreview("/opencode/missing-preview-directory", "mobile")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe("Start the preview before running an audit.")
  })
})

const report: Lhr = {
  finalDisplayedUrl: "http://127.0.0.1:5199/",
  fetchTime: "2026-01-01T00:00:00.000Z",
  categories: {
    performance: { score: 0.93 },
    accessibility: { score: 1 },
    "best-practices": { score: 0.5 },
    seo: { score: null },
    "agentic-browsing": { score: 0.5, auditRefs: [{ id: "agent-1" }, { id: "agent-2" }, { id: "skipped" }] },
  },
  audits: {
    "first-contentful-paint": { id: "first-contentful-paint", title: "FCP", score: 1, displayValue: "0.7 s" },
    "largest-contentful-paint": { id: "largest-contentful-paint", title: "LCP", score: 0.6, displayValue: "2.4 s" },
    "total-blocking-time": { id: "total-blocking-time", title: "TBT", score: 0.8, displayValue: "120 ms" },
    "cumulative-layout-shift": { id: "cumulative-layout-shift", title: "CLS", score: 1, displayValue: "0" },
    "speed-index": { id: "speed-index", title: "SI", score: 1, displayValue: "1.5 s" },
    "uses-http2": { id: "uses-http2", title: "HTTP/2", score: 0, displayValue: "" },
    "unused-javascript": { id: "unused-javascript", title: "Unused JS", score: 0.3, displayValue: "40 KiB" },
    "manual-check": { id: "manual-check", title: "Manual", score: null, displayValue: "", scoreDisplayMode: "manual" },
    informative: { id: "informative", title: "Info", score: 0, displayValue: "", scoreDisplayMode: "informative" },
    "agent-1": { id: "agent-1", title: "Agent one", score: 1, displayValue: "" },
    "agent-2": { id: "agent-2", title: "Agent two", score: 0, displayValue: "Missing" },
    skipped: { id: "skipped", title: "Skipped", score: null, displayValue: "", scoreDisplayMode: "notApplicable" },
  },
}

describe("lighthouse report mapping", () => {
  test("scales category scores to percentages", () => {
    const result = mapResult(report, "fallback")
    expect(result.url).toBe("http://127.0.0.1:5199/")
    expect(result.categories).toEqual({
      performance: 93,
      accessibility: 100,
      best_practices: 50,
      seo: null,
      agentic_browsing: 50,
    })
  })

  test("collects the core metrics", () => {
    const result = mapResult(report, "fallback")
    expect(result.metrics).toEqual({ fcp: "0.7 s", lcp: "2.4 s", tbt: "120 ms", cls: "0", si: "1.5 s" })
  })

  test("keeps scored failures sorted worst-first and drops informative audits", () => {
    const result = mapResult(report, "fallback")
    expect(result.failed.map((audit) => audit.id)).toEqual([
      "uses-http2",
      "agent-2",
      "unused-javascript",
      "largest-contentful-paint",
      "total-blocking-time",
    ])
    expect(result.failed.some((audit) => audit.id === "manual-check")).toBe(false)
    expect(result.failed.some((audit) => audit.id === "informative")).toBe(false)
  })

  test("summarises the agentic browsing audits", () => {
    const result = mapResult(report, "fallback")
    expect(result.agentic_browsing).toEqual({
      passed: 1,
      total: 2,
      audits: [
        { id: "agent-1", title: "Agent one", display: "", score: 1 },
        { id: "agent-2", title: "Agent two", display: "Missing", score: 0 },
      ],
    })
  })

  test("falls back to the target url and current time", () => {
    const result = mapResult({}, "http://localhost:1234/")
    expect(result.url).toBe("http://localhost:1234/")
    expect(Number.isNaN(Date.parse(result.fetch_time))).toBe(false)
    expect(result.agentic_browsing).toBeNull()
  })
})
