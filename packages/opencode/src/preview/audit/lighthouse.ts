// Runs Google Lighthouse on one page and keeps what the report needs: the five category scores, the lab metrics and
// the audits that failed. Lighthouse runs as its own Node process, so its weight never loads into the server.

import { execFile, spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import path from "node:path"
import type { Audit } from "./types"

const TIMEOUT = 150_000
const STDOUT_LIMIT = 64 << 20
const STDERR_LIMIT = 64 << 10
const MAX_FINDINGS = 40
const VERSION = "13.5.0"
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo", "agentic-browsing"]

const SCREEN: Record<Audit.FormFactor, { mobile: boolean; width: number; height: number; scale: number }> = {
  mobile: { mobile: true, width: 412, height: 823, scale: 1.75 },
  desktop: { mobile: false, width: 1350, height: 940, scale: 1 },
}

// The languages Lighthouse writes its findings in, by the app's locale codes where they differ.
const LOCALES = new Set([
  "ar", "bg", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es", "es-419", "fi", "fil", "fr", "he", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "no", "pl", "pt", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sr-Latn",
  "sv", "ta", "te", "th", "tr", "uk", "vi", "zh", "zh-HK", "zh-TW",
])
const ALIASES: Record<string, string> = {
  en: "en-US",
  br: "pt",
  "pt-BR": "pt",
  zht: "zh-TW",
  "zh-Hant": "zh-TW",
  "zh-Hans": "zh",
  nb: "no",
  bs: "hr",
  tl: "fil",
}

/** The Lighthouse locale for the app's locale, like "de" or "pt-BR"; English when Lighthouse has no such language. */
export function lighthouseLocale(locale: string | undefined) {
  if (!locale) return "en-US"
  const base = locale.split("-")[0] ?? locale

  return [ALIASES[locale] ?? locale, ALIASES[base] ?? base].find((item) => LOCALES.has(item)) ?? "en-US"
}

export async function runLighthouse(input: {
  url: string
  formFactor: Audit.FormFactor
  locale: string
  chrome: string
  cwd: string
  signal: AbortSignal
}): Promise<Audit.Lighthouse> {
  const screen = SCREEN[input.formFactor]
  const args = [
    input.url,
    "--output=json",
    "--output-path=stdout",
    "--quiet",
    `--locale=${input.locale}`,
    `--only-categories=${CATEGORIES.join(",")}`,
    `--form-factor=${input.formFactor}`,
    `--screenEmulation.mobile=${screen.mobile}`,
    `--screenEmulation.width=${screen.width}`,
    `--screenEmulation.height=${screen.height}`,
    `--screenEmulation.deviceScaleFactor=${screen.scale}`,
    "--throttling-method=simulate",
    "--max-wait-for-load=35000",
    "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
  ]
  const output = await run("node", [await lighthouseCli(), ...args], input)

  return mapReport(parseReport(output), input.url)
}

// The copy installed with the server in development. A built server has none, so the pinned version installs once
// into the user's cache and every later audit starts it directly; `npm exec` would re-resolve it on every run.
async function lighthouseCli() {
  const bundled = resolveBundled()

  if (bundled) return bundled
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "omai", `lighthouse-${VERSION}`)
  const entry = path.join(dir, "node_modules", "lighthouse", "cli", "index.js")
  const installed = await access(entry).then(
    () => true,
    () => false,
  )

  if (installed) return entry
  install.current ??= installInto(dir).finally(() => (install.current = undefined))
  await install.current

  return entry
}

// One install at a time, shared by audits that start while it runs.
const install: { current?: Promise<void> } = {}

function installInto(dir: string) {
  return new Promise<void>((resolve, reject) =>
    execFile(
      "npm",
      ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", `lighthouse@${VERSION}`],
      { timeout: 300_000 },
      (error) => (error ? reject(new Error("Lighthouse could not be installed. Is npm installed?")) : resolve()),
    ),
  )
}

function resolveBundled() {
  const name = "lighthouse/cli/index.js"

  try {
    return createRequire(import.meta.url).resolve(name)
  } catch {
    return undefined
  }
}

function run(command: string, args: string[], input: { chrome: string; cwd: string; signal: AbortSignal }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: { ...process.env, CHROME_PATH: input.chrome },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const size = { out: 0, err: 0 }
    const settled = { done: false }

    const finish = (fn: () => void) => {
      if (settled.done) return
      settled.done = true
      clearTimeout(timer)
      input.signal.removeEventListener("abort", abort)
      fn()
    }
    const abort = () => {
      child.kill("SIGKILL")
      finish(() => reject(new Error("The audit was cancelled.")))
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(() => reject(new Error("Lighthouse took too long.")))
    }, TIMEOUT)
    input.signal.addEventListener("abort", abort)

    child.on("error", () => finish(() => reject(new Error("Lighthouse could not start. Is Node.js installed?"))))
    child.stdout.on("data", (chunk: Buffer) => {
      size.out += chunk.length

      if (size.out > STDOUT_LIMIT) return abort()
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (size.err > STDERR_LIMIT) return
      size.err += chunk.length
      stderr.push(chunk)
    })
    child.on("close", (code) => {
      if (code === 0) return finish(() => resolve(Buffer.concat(stdout).toString("utf8")))
      const message = Buffer.concat(stderr).toString("utf8").trim().split("\n").at(-1)?.trim()
      finish(() => reject(new Error(message || "Lighthouse could not produce a report.")))
    })
  })
}

function parseReport(output: string): Lhr {
  const start = output.indexOf("{")

  if (start === -1) throw new Error("Lighthouse returned no report.")

  try {
    // SAFETY: Lighthouse's own JSON report; mapReport reads every field optionally.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return JSON.parse(output.slice(start)) as Lhr
  } catch {
    throw new Error("Lighthouse returned an unreadable report.")
  }
}

/** The parts of a Lighthouse report the audit keeps. */
export function mapReport(lhr: Lhr, fallback: string): Audit.Lighthouse {
  const audits = Object.values(lhr.audits ?? {})

  return {
    url: lhr.finalDisplayedUrl || lhr.finalUrl || fallback,
    fetchTime: lhr.fetchTime ?? new Date().toISOString(),
    categories: {
      performance: percent(lhr.categories?.performance?.score),
      accessibility: percent(lhr.categories?.accessibility?.score),
      bestPractices: percent(lhr.categories?.["best-practices"]?.score),
      seo: percent(lhr.categories?.seo?.score),
      agentic: percent(lhr.categories?.["agentic-browsing"]?.score),
    },
    metrics: {
      fcp: metric(lhr, "first-contentful-paint"),
      lcp: metric(lhr, "largest-contentful-paint"),
      tbt: metric(lhr, "total-blocking-time"),
      cls: metric(lhr, "cumulative-layout-shift"),
      si: metric(lhr, "speed-index"),
    },
    failed: audits
      .filter(failing)
      .map((audit) => ({ id: audit.id, title: audit.title, display: audit.displayValue ?? "", score: audit.score }))
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      .slice(0, MAX_FINDINGS),
    agentic: agentic(lhr),
  }
}

const percent = (score: number | null | undefined) => (typeof score === "number" ? Math.round(score * 100) : null)

const metric = (lhr: Lhr, id: string) => lhr.audits?.[id]?.displayValue || null

const scored = (audit: LhrAudit) =>
  audit.scoreDisplayMode !== "informative" &&
  audit.scoreDisplayMode !== "notApplicable" &&
  audit.scoreDisplayMode !== "manual"

const failing = (audit: LhrAudit) => audit.score !== null && audit.score < 0.9 && scored(audit)

function agentic(lhr: Lhr) {
  const audits = (lhr.categories?.["agentic-browsing"]?.auditRefs ?? []).flatMap((ref) => {
    const audit = lhr.audits?.[ref.id]

    return audit && audit.score !== null && scored(audit) ? [audit] : []
  })

  if (audits.length === 0) return null

  return { passed: audits.filter((audit) => audit.score === 1).length, total: audits.length }
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
