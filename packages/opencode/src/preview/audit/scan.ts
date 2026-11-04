// The audit's own checks: what one request for the page, its headers, its HTML and a few well-known files say about
// the site. Lighthouse measures the page in a browser; these cover what it leaves out, like security headers, broken
// links, structured data and social previews.

import { connect } from "node:tls"
import type { Audit } from "./types"

const TIMEOUT = 12_000
const MAX_LINKS = 25
const LINK_CONCURRENCY = 5
const SLOW_TTFB = 800
const CERTIFICATE_WARNING_DAYS = 14
const USER_AGENT = "Mozilla/5.0 (compatible; OMAI-Audit/1.0)"

// Country-code domains that are used as generic ones and say nothing about where a business is.
const GENERIC_CC = new Set(["io", "ai", "co", "me", "tv", "fm", "ly", "sh", "gg", "to", "cc", "ws", "app", "dev"])

export interface ScanResult {
  technical: Audit.Technical
  checks: Audit.Check[]
}

/**
 * Fetches the page and checks it. `local` marks the project's own dev server: hosting decides HTTPS and the security
 * headers, so those checks are left out there.
 */
export async function scanSite(input: { url: string; local: boolean; signal: AbortSignal }): Promise<ScanResult> {
  const started = performance.now()
  const response = await request(input.url, input.signal, "GET")
  const ttfb = performance.now() - started
  const html = await response.text()
  const loadTime = performance.now() - started
  const final = new URL(response.url || input.url)
  const https = final.protocol === "https:"
  const headers = response.headers
  const page = parseHtml(html, final)
  const [certificateDays, links, files] = await Promise.all([
    https ? certificate(final.hostname).catch(() => undefined) : Promise.resolve(undefined),
    checkLinks(page.links, input.signal),
    wellKnown(final, input.signal),
  ])

  const technical: Audit.Technical = {
    status: response.status,
    loadTime: Math.round(loadTime),
    ttfb: Math.round(ttfb),
    size: Buffer.byteLength(html),
    https,
    certificateDays,
    server: headers.get("server") ?? headers.get("x-powered-by") ?? undefined,
    cms: page.cms ?? cmsFromHeaders(headers),
    country: country(final.hostname),
    links: links.checked,
    title: page.title,
  }

  const check = (
    when: boolean,
    id: string,
    group: Audit.Group,
    severity: Audit.Severity,
    values?: Record<string, string | number>,
  ): Audit.Check[] => (when ? [{ id, group, severity, values }] : [])
  const remote = !input.local
  const csp = headers.get("content-security-policy") ?? ""

  const checks = [
    ...check(response.status >= 400, "status-error", "reachability", "critical", { status: response.status }),
    ...check(links.broken.length > 0, "broken-links", "reachability", "medium", {
      count: links.broken.length,
      links: links.broken.map((link) => `${link.url} (HTTP ${link.status || "–"})`).join(", "),
    }),
    ...check(ttfb > SLOW_TTFB, "slow-response", "reachability", "medium", { ms: Math.round(ttfb) }),
    ...check(page.noindex, "noindex", "reachability", "high"),
    ...check(!page.types.some((type) => /LocalBusiness|Store|Restaurant|Organization/.test(type)), "no-local-business", "geo", "medium"),
    ...check(!page.lang, "no-lang", "geo", "low"),
    ...check(page.types.length === 0 && !page.microdata, "no-structured-data", "agentic", "medium"),
    ...check(!files.llms, "no-llms-txt", "agentic", "optional"),
    ...check(!page.ogImage, "no-social-image", "design", "medium"),
    ...check(!page.viewport, "no-viewport", "design", "high"),
    ...check(!page.favicon && !files.favicon, "no-favicon", "design", "low"),
    ...check(!page.themeColor, "no-theme-color", "design", "low"),
    ...check(!page.title, "no-title", "technical", "high"),
    ...check(!page.description, "no-description", "technical", "medium"),
    ...check(page.h1 === 0, "no-h1", "technical", "low"),
    ...check(page.h1 > 1, "many-h1", "technical", "low", { count: page.h1 }),
    ...check(!page.canonical, "no-canonical", "technical", "low"),
    ...check(remote && !https, "no-https", "technical", "critical"),
    ...check(remote && https && !headers.get("strict-transport-security"), "no-hsts", "technical", "medium"),
    ...check(remote && !csp, "no-csp", "technical", "medium"),
    ...check(
      remote && !headers.get("x-frame-options") && !/frame-ancestors/i.test(csp),
      "no-clickjacking",
      "technical",
      "low",
    ),
    ...check(
      certificateDays !== undefined && certificateDays < CERTIFICATE_WARNING_DAYS,
      "certificate-expiring",
      "technical",
      "high",
      { days: certificateDays ?? 0 },
    ),
    ...check(https && page.mixed > 0, "mixed-content", "technical", "medium", { count: page.mixed }),
    ...check(page.legacyAnalytics, "legacy-analytics", "technical", "low"),
    ...check(remote && !files.robots, "no-robots", "technical", "low"),
    ...check(remote && !files.sitemap, "no-sitemap", "technical", "low"),
    ...check(remote && !headers.get("referrer-policy"), "no-referrer-policy", "technical", "info"),
    ...check(remote && !headers.get("permissions-policy"), "no-permissions-policy", "technical", "info"),
  ]

  return { technical, checks }
}

function request(url: string, signal: AbortSignal, method: "GET" | "HEAD") {
  return fetch(url, {
    method,
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
  })
}

/** What the page's HTML says about it. */
export function parseHtml(html: string, base: URL) {
  const head = html.slice(0, 200_000)
  const meta = (name: string) =>
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i").exec(head)?.[0]
  const content = (tag: string | undefined) => (tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1]?.trim() : undefined)
  const generator = content(meta("generator"))
  const types = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap((type) =>
      (type[1] ?? "").replace(/[[\]"]/g, "").split(",").map((item) => item.trim()).filter(Boolean),
    ),
  )
  const links = [
    ...new Set(
      [...html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["']/gi)].flatMap((match) => {
        const href = URL.parse(match[1] ?? "", base.href)

        if (!href || href.host !== base.host || !/^https?:$/.test(href.protocol)) return []
        href.hash = ""

        return href.href === base.href ? [] : [href.href]
      }),
    ),
  ]

  return {
    title: decode(/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim() ?? "") || undefined,
    description: content(meta("description")),
    lang: /<html[^>]+lang=["']([^"']+)["']/i.exec(head)?.[1],
    viewport: !!meta("viewport"),
    themeColor: !!meta("theme-color"),
    ogImage: !!content(meta("og:image")) || !!content(meta("twitter:image")),
    favicon: /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(head),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(head),
    noindex: /noindex/i.test(content(meta("robots")) ?? ""),
    h1: (html.match(/<h1[\s>]/gi) ?? []).length,
    types,
    microdata: /itemtype=["']https?:\/\/schema\.org/i.test(html),
    mixed: (html.match(/<(?:script|img|link|iframe)[^>]+(?:src|href)=["']http:\/\//gi) ?? []).length,
    legacyAnalytics: /["']UA-\d{4,}-\d+["']|google-analytics\.com\/analytics\.js|google-analytics\.com\/ga\.js/i.test(html),
    cms: generator ? cleanGenerator(generator) : cmsFromHtml(html),
    links,
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

// The few HTML entities titles use, so the report shows "A & B" rather than "A &amp; B".
function decode(text: string) {
  return text.replace(/&(#x?[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match
    const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)

    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  })
}

function cleanGenerator(generator: string) {
  return generator.replace(/\s*-\s*https?:\/\/\S+$/, "").slice(0, 60)
}

function cmsFromHtml(html: string) {
  if (/wp-content\/|wp-includes\//i.test(html)) return "WordPress"

  if (/cdn\.shopify\.com/i.test(html)) return "Shopify"

  if (/static\.wixstatic\.com|wix\.com/i.test(html)) return "Wix"

  if (/squarespace\.com|static1\.squarespace/i.test(html)) return "Squarespace"

  if (/webflow\.(?:com|io)/i.test(html)) return "Webflow"

  if (/\/sites\/default\/files|Drupal\.settings/i.test(html)) return "Drupal"

  if (/\/media\/jui\/|Joomla!/i.test(html)) return "Joomla"

  if (/__NEXT_DATA__|\/_next\/static/i.test(html)) return "Next.js"

  if (/__NUXT__|\/_nuxt\//i.test(html)) return "Nuxt"

  if (/astro-island|\/_astro\//i.test(html)) return "Astro"

  if (/___gatsby/i.test(html)) return "Gatsby"

  return undefined
}

function cmsFromHeaders(headers: Headers) {
  const powered = headers.get("x-powered-by") ?? ""

  if (/wordpress|wp engine/i.test(powered)) return "WordPress"

  if (headers.get("x-shopify-stage")) return "Shopify"

  if (/next\.js/i.test(powered)) return "Next.js"

  return undefined
}

/** The country a hostname's top-level domain names, like "CH" for example.ch. */
export function country(hostname: string) {
  if (/^[\d.]+$|^\[|localhost$/i.test(hostname)) return undefined
  const tld = hostname.split(".").at(-1)?.toLowerCase() ?? ""

  if (tld.length !== 2 || GENERIC_CC.has(tld)) return undefined

  return tld === "uk" ? "GB" : tld.toUpperCase()
}

async function checkLinks(links: string[], signal: AbortSignal) {
  const queue = links.slice(0, MAX_LINKS)
  const broken: { url: string; status: number }[] = []
  const worker = async (): Promise<void> => {
    const url = queue.shift()

    if (!url || signal.aborted) return
    const status = await linkStatus(url, signal)

    if (status === 0 || status >= 400) broken.push({ url, status })

    return worker()
  }
  await Promise.all(Array.from({ length: LINK_CONCURRENCY }, worker))

  return { checked: Math.min(links.length, MAX_LINKS), broken }
}

async function linkStatus(url: string, signal: AbortSignal) {
  const head = await request(url, signal, "HEAD").catch(() => undefined)

  if (head && head.status !== 405 && head.status !== 501) return head.status
  const get = await request(url, signal, "GET").catch(() => undefined)
  await get?.body?.cancel().catch(() => undefined)

  return get?.status ?? 0
}

async function wellKnown(base: URL, signal: AbortSignal) {
  const exists = async (path: string) => {
    const response = await request(new URL(path, base).href, signal, "GET").catch(() => undefined)

    if (!response) return false
    const type = response.headers.get("content-type") ?? ""
    await response.body?.cancel().catch(() => undefined)

    // Single-page apps answer every path with their HTML page; that is not the file.
    return response.ok && (path === "/favicon.ico" || !type.includes("text/html"))
  }
  const [robots, sitemap, llms, favicon] = await Promise.all(
    ["/robots.txt", "/sitemap.xml", "/llms.txt", "/favicon.ico"].map(exists),
  )

  return { robots, sitemap, llms, favicon }
}

function certificate(hostname: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443, servername: hostname, timeout: 8_000 }, () => {
      const validTo = socket.getPeerCertificate().valid_to
      socket.end()

      if (!validTo) return reject(new Error("No certificate."))
      resolve(Math.floor((new Date(validTo).getTime() - Date.now()) / 86_400_000))
    })
    socket.once("error", reject)
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("Timed out."))
    })
  })
}

const PENALTY: Record<Audit.Severity, number> = { critical: 25, high: 12, medium: 6, low: 2, optional: 0, info: 0 }

/** The overall score: Lighthouse's categories weigh 70%, the own checks 30%; the checks alone without Lighthouse. */
export function overallScore(lighthouse: Audit.Lighthouse | undefined, checks: readonly Audit.Check[]) {
  const own = Math.max(0, 100 - checks.reduce((sum, check) => sum + PENALTY[check.severity], 0))
  const scores = lighthouse
    ? Object.values(lighthouse.categories).filter((score): score is number => score !== null)
    : []

  if (scores.length === 0) return own
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length

  return Math.round(average * 0.7 + own * 0.3)
}
