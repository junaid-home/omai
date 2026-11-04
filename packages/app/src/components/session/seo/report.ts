// The website audit as a printable A4 page: the cover with the scores, the technical metrics and findings, the
// Lighthouse notes, and the legal pages. The window writes it in the user's language; the server only prints it.
// A printed document carries its own type, so it names system fonts.

import type { Audit } from "./types"
import {
  CATEGORIES,
  METRICS,
  categoryLabel,
  checkCopy,
  formatBytes,
  formatDate,
  formatSeconds,
  grouped,
  isError,
  isMajor,
  rating,
  reportNumber,
  siteName,
  tone,
  verdict,
  type Plural,
  type Translate,
} from "./model"

export interface ReportMeta {
  client: string
  location: string
  /** The brand icon as a data URL; the page loads nothing. */
  logo?: string
}

const BRAND = "O M A I +"

const COLOR: Record<ReturnType<typeof tone>, string> = {
  good: "#2f7d32",
  fair: "#b26a00",
  poor: "#c0392b",
  unknown: "#8a94a3",
}

const SEVERITY_COLOR: Record<Audit.Severity, { fg: string; bg: string }> = {
  critical: { fg: "#b42318", bg: "#fdecea" },
  high: { fg: "#c2410c", bg: "#fff1e6" },
  medium: { fg: "#b26a00", bg: "#fff4dc" },
  low: { fg: "#1d4ed8", bg: "#e8efff" },
  optional: { fg: "#5b6675", bg: "#eef1f5" },
  info: { fg: "#5b6675", bg: "#eef1f5" },
}

export function reportHtml(report: Audit.Report, meta: ReportMeta, t: Translate, plural: Plural, locale: string) {
  const site = siteName(report.url)
  const date = (time: number) => formatDate(time, locale)
  const client = meta.client.trim() || site
  const lighthouse = report.lighthouse
  const groups = grouped(report.checks)
  const majors = report.checks.filter(isMajor).length
  const page = esc(t("pdf.page"))

  const brand = `<div class="brand">${meta.logo ? `<img src="${meta.logo}" alt="">` : ""}<div><b>${BRAND}</b><span>${esc(t("pdf.subtitle"))}</span></div></div>`

  const cover = `
<header class="top">
  ${brand}
  <div class="kicker"><b>${esc(t("pdf.kicker"))}</b><span>${esc(t("pdf.number", { number: reportNumber(report) }))}</span><span>${esc(date(report.createdAt))}</span></div>
</header>
<table class="meta">
  <tr><th>${esc(t("pdf.client"))}</th><td><b>${esc(client)}</b></td><th>${esc(t("pdf.website"))}</th><td>${esc(site)}</td></tr>
  <tr><th>${esc(t("pdf.location"))}</th><td>${esc(meta.location || "–")}</td><th>${esc(t("pdf.scan"))}</th><td>${esc(date(report.createdAt))}</td></tr>
</table>
<h1>${esc(t("pdf.heading", { client }))}</h1>
<p class="lead">${esc(t("pdf.intro", { site: "\u0000" })).replace("\u0000", `<b>${esc(site)}</b>`)}</p>
<p class="overall" style="color:${COLOR[tone(report.score)]}">${esc(t("pdf.overall", { score: report.score, verdict: t(verdict(report.score)) }))}</p>
${
  lighthouse
    ? `<div class="gauges">${CATEGORIES.map((category) => gauge(lighthouse.categories[category], categoryLabel(category, t))).join("")}</div>
<h2>${esc(t("pdf.overview"))}</h2>
<table class="grid">
  <thead><tr><th>${esc(t("pdf.area"))}</th><th class="num">${esc(t("pdf.score"))}</th><th>${esc(t("pdf.rating"))}</th></tr></thead>
  <tbody>${CATEGORIES.map((category) => {
    const score = lighthouse.categories[category]

    return `<tr><td>${esc(categoryLabel(category, t))}</td><td class="num" style="color:${COLOR[tone(score)]}"><b>${score ?? "–"} / 100</b></td><td>${esc(t(rating(score)))}</td></tr>`
  }).join("")}</tbody>
</table>
<p class="note">${esc(t("pdf.measured", { time: lighthouse.fetchTime, url: lighthouse.url, saved: date(report.createdAt) }))}</p>
<h2>${esc(t("pdf.metrics"))}</h2>
<div class="tiles">${METRICS.map((metric) => tile(metric.label.includes(".") ? t(metric.label) : metric.label, lighthouse.metrics[metric.key] ?? "–")).join("")}</div>`
    : `<p class="note">${esc(t("lighthouse.unavailable", { reason: report.lighthouseError ?? "" }))}</p>`
}`

  const technical = report.technical

  const tech = technical
    ? `<h2>${esc(t("pdf.technical"))}</h2>
<div class="tiles">${[
        tile(t("technical.status"), String(technical.status)),
        tile(t("technical.loadTime"), formatSeconds(technical.loadTime, locale)),
        tile(t("technical.ttfb"), `${technical.ttfb} ms`),
        tile(t("technical.size"), formatBytes(technical.size, locale)),
        tile(t("technical.https"), technical.https ? t("technical.https.yes") : t("technical.https.no")),
        ...(technical.certificateDays === undefined
          ? []
          : [tile(t("technical.certificate"), plural("technical.certificate.days", technical.certificateDays))]),
        ...(technical.country ? [tile(t("technical.country"), technical.country)] : []),
        ...(technical.cms ? [tile(t("technical.cms"), technical.cms)] : []),
        ...(technical.server ? [tile(t("technical.server"), technical.server)] : []),
        tile(t("technical.links"), String(technical.links)),
      ].join("")}</div>`
    : `<p class="note">${esc(t("technical.unavailable", { reason: report.technicalError ?? "" }))}</p>`

  const checks = `<h2>${esc(t("pdf.checks"))}</h2>
<p class="note">${esc(plural("checks.summary", report.checks.length, { major: majors }))}</p>
${groups
  .map(
    (entry) => `<h3>${esc(t(`group.${entry.group}`))} <span class="count">${entry.items.length}</span></h3>
<table class="grid findings">
  <thead><tr><th class="sev">${esc(t("pdf.severity"))}</th><th class="what">${esc(t("pdf.finding"))}</th><th>${esc(t("pdf.details"))}</th></tr></thead>
  <tbody>${entry.items
    .map((check) => {
      const copy = checkCopy(check, t)

      return `<tr><td>${pill(t(`severity.${check.severity}`), SEVERITY_COLOR[check.severity])}</td><td><b>${esc(copy.title)}</b></td><td class="muted">${esc(copy.detail)}</td></tr>`
    })
    .join("")}</tbody>
</table>`,
  )
  .join("")}`

  const notes = lighthouse?.failed.length
    ? `<h3>${esc(t("pdf.lighthouse"))} <span class="count">${lighthouse.failed.length}</span></h3>
<table class="grid findings">
  <thead><tr><th class="sev">${esc(t("pdf.status"))}</th><th>${esc(t("pdf.audit"))}</th><th class="value">${esc(t("pdf.value"))}</th></tr></thead>
  <tbody>${lighthouse.failed
    .map(
      (finding) =>
        `<tr><td>${pill(
          t(isError(finding) ? "severity.error" : "severity.warning"),
          SEVERITY_COLOR[isError(finding) ? "critical" : "medium"],
        )}</td><td><b>${code(finding.title)}</b></td><td class="muted">${esc(finding.display)}</td></tr>`,
    )
    .join("")}</tbody>
</table>`
    : ""

  const legal = `<section class="legal">
<header class="top slim">${brand}<div class="kicker"><b>${esc(t("pdf.legalKicker"))}</b></div></header>
<h1>${esc(t("pdf.legal.title"))}</h1>
<p class="lead">${esc(t("pdf.legal.intro"))}</p>
<h2 class="plain">${esc(t("pdf.legal.clarifications"))}</h2>
${(["recommendations", "structured", "privacy", "scores"] as const)
  .map((key) => `<h4>${esc(t(`pdf.legal.${key}.title`))}</h4><p>${esc(t(`pdf.legal.${key}.body`))}</p>`)
  .join("")}
</section>
<section class="legal notes">
<div class="band"></div>
<h1>${esc(t("pdf.notes.title"))}</h1>
<p class="sub">${esc(t("pdf.notes.subtitle", { client, site }))}</p>
${(["purpose", "validity", "violations", "privacy", "fair"] as const)
  .map((key) => `<h4 class="part">${esc(t(`pdf.notes.${key}.title`))}</h4><p>${esc(t(`pdf.notes.${key}.body`))}</p>`)
  .join("")}
<h4 class="part">${esc(t("pdf.notes.qa.title"))}</h4>
<table class="qa">
  <thead><tr><th>${esc(t("pdf.notes.qa.area"))}</th><th>${esc(t("pdf.notes.qa.check"))}</th></tr></thead>
  <tbody>${(["technical", "privacy", "security", "accessibility", "external"] as const)
    .map((key) => `<tr><td>${esc(t(`pdf.notes.qa.${key}`))}</td><td>${esc(t(`pdf.notes.qa.${key}.body`))}</td></tr>`)
    .join("")}</tbody>
</table>
<p class="note">${esc(t("pdf.notes.reference"))}</p>
<h2 class="plain">${esc(t("pdf.notes.limitation.title"))}</h2>
<p>${esc(t("pdf.notes.limitation.body"))}</p>
</section>`

  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<title>${esc(t("pdf.heading", { client }))}</title>
<style>${STYLE.replaceAll("__PAGE__", page).replace("__BRAND__", BRAND)}</style>
</head>
<body>
<section class="main">
${cover}
${tech}
${checks}
${notes}
<footer class="end"><span>${esc(t("pdf.created", { created: date(Date.now()), scan: date(report.createdAt) }))}</span><b>${BRAND}</b></footer>
</section>
${legal}
</body>
</html>`
}

function gauge(score: number | null, label: string) {
  const radius = 30
  const circumference = 2 * Math.PI * radius
  const dash = ((score ?? 0) / 100) * circumference
  const color = COLOR[tone(score)]

  return `<figure class="gauge"><svg viewBox="0 0 76 76" width="76" height="76"><circle cx="38" cy="38" r="${radius}" fill="none" stroke="#e5e8ec" stroke-width="6"/>${
    score === null
      ? ""
      : `<circle cx="38" cy="38" r="${radius}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}" transform="rotate(-90 38 38)"/>`
  }<text x="38" y="44" text-anchor="middle" font-size="18" font-weight="700" fill="${color}">${score ?? "–"}</text></svg><figcaption>${esc(label)}</figcaption></figure>`
}

const tile = (label: string, value: string) =>
  `<div class="tile"><span>${esc(label)}</span><b>${esc(value)}</b></div>`

const pill = (label: string, color: { fg: string; bg: string }) =>
  `<span class="pill" style="color:${color.fg};background:${color.bg}">${esc(label)}</span>`

// Lighthouse titles mark code with backticks.
const code = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>")

function esc(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

const STYLE = `
@page { size: A4; margin: 18mm 16mm 20mm;
  @bottom-left { content: "__BRAND__"; font: 700 8pt Helvetica, Arial, sans-serif; color: #1f2329; }
  @bottom-right { content: "__PAGE__ " counter(page) " / " counter(pages); font: 8pt Helvetica, Arial, sans-serif; color: #6b7480; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.5pt/1.45 Helvetica, Arial, sans-serif; color: #1f2329; }
b { font-weight: 700; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
.top { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 12px; border-bottom: 2.5px solid #111; }
.top.slim { margin-bottom: 18px; }
.brand { display: flex; gap: 10px; align-items: center; }
.brand img { width: 34px; height: 34px; border-radius: 8px; }
.brand b { display: block; font-size: 16pt; letter-spacing: .02em; }
.brand span { display: block; font-size: 8pt; color: #5b6675; }
.kicker { text-align: right; font-size: 8.5pt; color: #5b6675; }
.kicker b { display: block; font-size: 11pt; color: #111; letter-spacing: .06em; text-transform: uppercase; }
.kicker span { display: block; }
table { width: 100%; border-collapse: collapse; }
.meta { margin: 6px 0 4px; border-bottom: 1px solid #e3e6ea; }
.meta th { width: 13%; text-align: left; font-size: 7.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #8a94a3; padding: 7px 0; }
.meta td { padding: 7px 0; }
h1 { font-size: 17pt; margin: 18px 0 6px; letter-spacing: -.01em; }
h2 { font-size: 11.5pt; margin: 22px 0 10px; padding-bottom: 7px; border-bottom: 2px solid #111; break-after: avoid; }
h2.plain { border: 0; padding: 0; margin-top: 20px; }
h3 { font-size: 10pt; margin: 16px 0 6px; break-after: avoid; }
h4 { font-size: 9pt; color: #24456b; margin: 14px 0 4px; break-after: avoid; }
p { margin: 0 0 8px; }
.lead { color: #4b5563; }
.overall { font-weight: 700; font-size: 10.5pt; margin: 4px 0 2px; }
.note { font-size: 8pt; color: #8a94a3; margin-top: 6px; }
.count { display: inline-block; min-width: 16px; padding: 1px 5px; border-radius: 9px; background: #111; color: #fff; font-size: 7pt; text-align: center; vertical-align: middle; }
.gauges { display: flex; gap: 14px; margin: 14px 0 4px; }
.gauge { margin: 0; text-align: center; width: 92px; }
.gauge figcaption { font-size: 7.5pt; font-weight: 700; color: #4b5563; margin-top: 2px; }
.grid thead th { background: #f4f6f8; text-align: left; font-size: 7.5pt; letter-spacing: .08em; text-transform: uppercase; color: #5b6675; padding: 7px 10px; border-bottom: 2px solid #111; }
.grid td { padding: 7px 10px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
.grid tbody tr:nth-child(even) td { background: #fafbfc; }
.grid tr { break-inside: avoid; }
.num { text-align: right; white-space: nowrap; }
.findings .sev { width: 17%; }
.findings .what { width: 34%; }
.findings .value { width: 22%; }
.muted { color: #5b6675; }
.pill { display: inline-block; padding: 2px 7px; border-radius: 9px; font-size: 6.8pt; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.tile { border: 1px solid #e3e6ea; border-radius: 6px; background: #f8f9fb; padding: 8px 12px; break-inside: avoid; }
.tile span { display: block; font-size: 7pt; letter-spacing: .08em; text-transform: uppercase; color: #8a94a3; }
.tile b { font-size: 10.5pt; }
.end { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 8px; border-top: 2.5px solid #111; font-size: 7.5pt; color: #8a94a3; }
.end b { color: #1f2329; }
.legal { break-before: page; }
.legal p { color: #4b5563; }
.notes .band { height: 8px; background: #1d5f7a; margin: 0 0 16px; border-radius: 2px; }
.notes h1 { font-size: 18pt; color: #13263a; margin: 0 0 4px; }
.notes h2.plain { margin-top: 12px; }
.notes .sub { color: #8a94a3; }
.notes { font-size: 8.8pt; line-height: 1.4; }
.notes p { margin-bottom: 5px; }
.notes h4.part { font-size: 10pt; color: #13263a; margin: 9px 0 3px; }
.qa { margin: 4px 0 6px; font-size: 8pt; }
.qa th { background: #13263a; color: #fff; text-align: left; padding: 6px 10px; }
.qa th:first-child, .qa td:first-child { width: 26%; }
.qa td { padding: 5px 10px; border: 1px solid #e3e6ea; }
.qa tbody tr:nth-child(even) td { background: #f6f8fa; }
`
