// Makes a report's PDF and downloads it. The client and place on its first page come from the audited page: its title,
// else its address, and the country its domain names.

import type { Audit } from "./types"
import { siteName, type Plural, type Translate } from "./model"
import { reportHtml } from "./report"

export async function downloadReport(
  report: Audit.Report,
  input: {
    pdf: (html: string) => Promise<{ readonly base64: string }>
    t: Translate
    plural: Plural
    locale: string
  },
) {
  const client = report.technical?.title ?? siteName(report.url)

  const html = reportHtml(
    report,
    { client, location: report.technical?.country ?? "", logo: await brandIcon() },
    input.t,
    input.plural,
    input.locale,
  )

  const result = await input.pdf(html)
  // A preview's address is a local port; the client names it better.
  const name = (report.preview ? client : siteName(report.url)).trim() || "report"

  save(result.base64, `website-audit-${name.replace(/[^\w.-]+/g, "-")}-${stamp(report.createdAt)}.pdf`)
}

// The brand icon from the app, inlined so the printed page loads nothing.
async function brandIcon() {
  const response = await fetch("/web-app-manifest-192x192.png").catch(() => undefined)

  if (!response?.ok) return undefined
  const blob = await response.blob()

  return new Promise<string | undefined>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(blob)
  })
}

function save(base64: string, name: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const stamp = (time: number) => new Date(time).toISOString().slice(0, 10)
