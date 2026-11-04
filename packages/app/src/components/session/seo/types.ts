// The website audit's report, as `global.preview.report` returns it and the app keeps it in its history. A copy of
// the server's `preview/audit/types.ts`; the generated SDK types are broader (see `fromWire` in session-seo-tab.tsx).

export namespace Audit {
  /** The screen Lighthouse emulates. */
  export type FormFactor = "mobile" | "desktop"

  /** One Lighthouse audit that did not pass, in the language the audit ran in. */
  export interface Finding {
    id: string
    title: string
    /** Lighthouse's own value for it, like "24.7 s"; empty when it has none. */
    display: string
    /** From 0 to 1; null when the audit has no score. */
    score: number | null
  }

  /** The five category scores, from 0 to 100; null when Lighthouse could not score one. */
  export interface Categories {
    performance: number | null
    accessibility: number | null
    bestPractices: number | null
    seo: number | null
    agentic: number | null
  }

  export type Category = keyof Categories

  export interface Metrics {
    fcp: string | null
    lcp: string | null
    tbt: string | null
    cls: string | null
    si: string | null
  }

  export interface Lighthouse {
    url: string
    fetchTime: string
    categories: Categories
    metrics: Metrics
    /** Failed audits, worst first. */
    failed: Finding[]
    agentic: { passed: number; total: number } | null
  }

  export type Severity = "critical" | "high" | "medium" | "low" | "optional" | "info"

  export type Group = "reachability" | "geo" | "agentic" | "design" | "technical"

  /** A finding of the own checks; the app names and explains it from `id` in the user's language. */
  export interface Check {
    id: string
    group: Group
    severity: Severity
    values?: Record<string, string | number>
  }

  export interface Technical {
    status: number
    loadTime: number
    ttfb: number
    size: number
    https: boolean
    certificateDays?: number
    server?: string
    cms?: string
    country?: string
    links: number
    title?: string
  }

  export interface Report {
    id: string
    /** The address the user asked for; the project's preview when `preview` is true. */
    url: string
    preview: boolean
    formFactor: FormFactor
    locale: string
    createdAt: number
    /** The overall score from 0 to 100: Lighthouse's categories and the own checks together. */
    score: number
    lighthouse?: Lighthouse
    lighthouseError?: string
    technical?: Technical
    technicalError?: string
    checks: Check[]
  }
}
