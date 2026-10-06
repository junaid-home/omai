import { spawn } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import { getDevServerStatus } from "./server"

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

export interface LighthouseAuditResult {
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

const AUDIT_TIMEOUT_MS = 150_000
const STDOUT_LIMIT = 64 << 20
const STDERR_LIMIT = 64 << 10
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo", "agentic-browsing"]

const SCREEN: Record<LighthouseFormFactor, { mobile: boolean; width: number; height: number; scale: number }> = {
  mobile: { mobile: true, width: 412, height: 823, scale: 1.75 },
  desktop: { mobile: false, width: 1280, height: 800, scale: 1 },
}

export function resolveLighthouseBin(): string {
  if (process.env.OPENCODE_LIGHTHOUSE_BIN) return process.env.OPENCODE_LIGHTHOUSE_BIN
  try {
    const local = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/.bin/lighthouse",
    )
    if (existsSync(local)) return local
  } catch {}
  return "lighthouse"
}

export async function auditPreview(directory: string, formFactor: LighthouseFormFactor): Promise<LighthouseAuditResult> {
  const status = getDevServerStatus(directory)
  if (!status.running || !status.port) throw new Error("Start the preview before running an audit.")

  const target = `http://127.0.0.1:${status.port}/`
  const screen = SCREEN[formFactor]
  const bin = resolveLighthouseBin()
  const args = [
    target,
    "--output=json",
    "--output-path=stdout",
    "--quiet",
    `--only-categories=${CATEGORIES.join(",")}`,
    `--form-factor=${formFactor}`,
    `--screenEmulation.mobile=${screen.mobile}`,
    `--screenEmulation.width=${screen.width}`,
    `--screenEmulation.height=${screen.height}`,
    `--screenEmulation.deviceScaleFactor=${screen.scale}`,
    "--throttling-method=simulate",
    "--max-wait-for-load=35000",
    "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
  ]

  const output = await run(bin, args, directory)
  const lhr = parseReport(output)
  return mapResult(lhr, target)
}

function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(() => reject(new Error("The audit timed out.")))
    }, AUDIT_TIMEOUT_MS)

    child.on("error", (error) =>
      finish(() => reject(error instanceof Error ? error : new Error("Could not run Lighthouse."))),
    )
    child.stdout.on("data", (chunk: Buffer) => {
      outLen += chunk.length
      if (outLen > STDOUT_LIMIT) {
        child.kill("SIGKILL")
        finish(() => reject(new Error("The audit report was too large.")))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (errLen > STDERR_LIMIT) return
      errLen += chunk.length
      stderr.push(chunk)
    })
    child.on("close", (code) => {
      if (code === 0) return finish(() => resolve(Buffer.concat(stdout).toString("utf8")))
      const message = lastLine(Buffer.concat(stderr).toString("utf8"))
      finish(() => reject(new Error(message || "Lighthouse could not produce a report.")))
    })
  })
}

function parseReport(output: string): Lhr {
  const start = output.indexOf("{")
  if (start === -1) throw new Error("Lighthouse returned no report.")
  try {
    const parsed: unknown = JSON.parse(output.slice(start))
    return parsed as Lhr
  } catch {
    throw new Error("Lighthouse returned an unreadable report.")
  }
}

function pct(score: number | undefined | null): number | null {
  return typeof score === "number" ? Math.round(score * 100) : null
}

function metric(lhr: Lhr, id: string): string | null {
  const audit = lhr.audits?.[id]
  return typeof audit?.displayValue === "string" && audit.displayValue ? audit.displayValue : null
}

export function mapResult(lhr: Lhr, fallback: string): LighthouseAuditResult {
  const failed = Object.values(lhr.audits ?? {})
    .filter((audit) => passFail(audit))
    .map(toFinding)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 25)

  return {
    url: lhr.finalDisplayedUrl || lhr.finalUrl || fallback,
    fetch_time: lhr.fetchTime ?? new Date().toISOString(),
    categories: {
      performance: pct(lhr.categories?.performance?.score),
      accessibility: pct(lhr.categories?.accessibility?.score),
      best_practices: pct(lhr.categories?.["best-practices"]?.score),
      seo: pct(lhr.categories?.seo?.score),
      agentic_browsing: pct(lhr.categories?.["agentic-browsing"]?.score),
    },
    metrics: {
      fcp: metric(lhr, "first-contentful-paint"),
      lcp: metric(lhr, "largest-contentful-paint"),
      tbt: metric(lhr, "total-blocking-time"),
      cls: metric(lhr, "cumulative-layout-shift"),
      si: metric(lhr, "speed-index"),
    },
    failed,
    agentic_browsing: agenticSummary(lhr),
  }
}

function passFail(audit: LhrAudit): boolean {
  if (audit.score === null || audit.score >= 1) return false
  return audit.scoreDisplayMode !== "informative" && audit.scoreDisplayMode !== "notApplicable"
}

function toFinding(audit: LhrAudit): LighthouseFinding {
  return { id: audit.id, title: audit.title, display: audit.displayValue ?? "", score: audit.score ?? null }
}

function agenticSummary(lhr: Lhr): LighthouseAgentic | null {
  const refs = lhr.categories?.["agentic-browsing"]?.auditRefs
  if (!refs?.length) return null
  const audits: LighthouseFinding[] = []
  let passed = 0
  for (const ref of refs) {
    const audit = lhr.audits?.[ref.id]
    if (!audit || audit.scoreDisplayMode === "notApplicable" || audit.scoreDisplayMode === "informative") continue
    if (audit.score === 1) passed++
    audits.push(toFinding(audit))
  }
  if (audits.length === 0) return null
  return { passed, total: audits.length, audits }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return lines[lines.length - 1]?.trim() ?? ""
}

export interface LhrAudit {
  id: string
  title: string
  score: number | null
  displayValue?: string
  scoreDisplayMode?: string
}

export interface Lhr {
  finalDisplayedUrl?: string
  finalUrl?: string
  fetchTime?: string
  audits?: Record<string, LhrAudit>
  categories?: Record<string, { score: number | null; auditRefs?: { id: string }[] }>
}

export * as PreviewLighthouse from "./lighthouse"
