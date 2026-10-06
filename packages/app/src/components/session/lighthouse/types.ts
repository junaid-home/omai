export type LighthouseFormFactor = "mobile" | "desktop"

export interface LighthouseFinding {
  id: string
  title: string
  display: string
  score: number | null
}

export interface LighthouseAgentic {
  passed: number
  total: number
  audits: LighthouseFinding[]
}

export interface LighthouseResult {
  url: string
  fetch_time: string
  categories: {
    performance: number | null
    accessibility: number | null
    best_practices: number | null
    seo: number | null
    agentic_browsing: number | null
  }
  metrics: {
    fcp: string | null
    lcp: string | null
    tbt: string | null
    cls: string | null
    si: string | null
  }
  failed: LighthouseFinding[]
  agentic_browsing: LighthouseAgentic | null
}

export const formFactors: { key: LighthouseFormFactor; label: string }[] = [
  { key: "mobile", label: "session.tools.seo.formFactor.mobile" },
  { key: "desktop", label: "session.tools.seo.formFactor.desktop" },
]

export function scoreTone(score: number | null) {
  if (score === null) return "unknown"
  if (score >= 90) return "good"
  if (score >= 50) return "fair"
  return "poor"
}
