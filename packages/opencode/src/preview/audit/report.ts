// One website audit: Google Lighthouse plus the own checks, for the project's preview or any address.

import { randomBytes } from "node:crypto"
import { findChrome } from "./chrome"
import { lighthouseLocale, runLighthouse } from "./lighthouse"
import { printPdf } from "./pdf"
import { overallScore, scanSite } from "./scan"
import type { Audit } from "./types"

export async function auditReport(input: {
  /** The page to audit: the preview's dev server, or a site the user named. */
  url: string
  preview: boolean
  formFactor: Audit.FormFactor
  /** The app's locale, like "de"; Lighthouse writes its findings in it when it can. */
  locale?: string
  cwd: string
  signal?: AbortSignal
}): Promise<Audit.Report> {
  const signal = input.signal ?? new AbortController().signal
  const chrome = findChrome()
  const locale = lighthouseLocale(input.locale)
  const [lighthouse, scan] = await Promise.all([
    chrome
      ? runLighthouse({ url: input.url, formFactor: input.formFactor, locale, chrome, cwd: input.cwd, signal }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error: message(error) }),
        )
      : Promise.resolve({ error: "Google Chrome is needed for Lighthouse. Install it, or set CHROME_PATH." }),
    scanSite({ url: input.url, local: input.preview, signal }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: message(error) }),
    ),
  ])
  const lighthouseValue = "value" in lighthouse ? lighthouse.value : undefined
  const checks = "value" in scan ? scan.value.checks : []

  if (!lighthouseValue && "error" in scan) throw new Error(scan.error)

  return {
    id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
    url: input.preview ? (lighthouseValue?.url ?? input.url) : input.url,
    preview: input.preview,
    formFactor: input.formFactor,
    locale,
    createdAt: Date.now(),
    score: overallScore(lighthouseValue, checks),
    lighthouse: lighthouseValue,
    lighthouseError: "error" in lighthouse ? lighthouse.error : undefined,
    technical: "value" in scan ? scan.value.technical : undefined,
    technicalError: "error" in scan ? scan.error : undefined,
    checks,
  }
}

/** Prints a report page the app wrote, in the user's language, to PDF. */
export async function reportPdf(html: string) {
  const chrome = findChrome()

  if (!chrome) throw new Error("Google Chrome is needed to make the PDF. Install it, or set CHROME_PATH.")

  return (await printPdf({ html, chrome })).toString("base64")
}

/** An address as typed, with `https://` when it names no scheme. */
export function normalizeSite(url: string) {
  const trimmed = url.trim()
  const parsed = URL.parse(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)

  if (!parsed || !/^https?:$/.test(parsed.protocol) || (!parsed.hostname.includes(".") && parsed.hostname !== "localhost"))
    throw new Error("Enter a website address, like example.com.")

  return parsed.href
}

const message = (error: unknown) => (error instanceof Error ? error.message : "The audit could not run.")
