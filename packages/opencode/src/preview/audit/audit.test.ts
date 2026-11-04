import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { lighthouseLocale, mapReport } from "./lighthouse"
import { country, overallScore, parseHtml, scanSite } from "./scan"
import { normalizeSite as normalize } from "./report"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function site(pages: Record<string, { status?: number; type?: string; body: string; headers?: Record<string, string> }>) {
  const server = createServer((req, res) => {
    const page = pages[new URL(req.url ?? "/", "http://site").pathname]

    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("missing")
      return
    }
    res.writeHead(page.status ?? 200, { "content-type": page.type ?? "text/html", ...page.headers })
    res.end(page.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()

  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`
}

describe("lighthouseLocale", () => {
  test("maps app locales to the languages Lighthouse writes in", () => {
    expect(lighthouseLocale("de")).toBe("de")
    expect(lighthouseLocale("de-CH")).toBe("de")
    expect(lighthouseLocale("zht")).toBe("zh-TW")
    expect(lighthouseLocale("pt-BR")).toBe("pt")
    expect(lighthouseLocale("en")).toBe("en-US")
  })

  test("falls back to English", () => {
    expect(lighthouseLocale(undefined)).toBe("en-US")
    expect(lighthouseLocale("am")).toBe("en-US")
  })
})

describe("mapReport", () => {
  test("keeps the scores, metrics and failing audits, worst first", () => {
    const result = mapReport(
      {
        finalDisplayedUrl: "https://example.com/",
        fetchTime: "2026-11-03T15:42:39.156Z",
        categories: {
          performance: { score: 0.4 },
          accessibility: { score: 0.86 },
          "best-practices": { score: 0.96 },
          seo: { score: 1 },
          "agentic-browsing": { score: 0.5, auditRefs: [{ id: "llms-txt" }, { id: "agent-tree" }] },
        },
        audits: {
          "largest-contentful-paint": { id: "largest-contentful-paint", title: "LCP", score: 0, displayValue: "24.7 s" },
          "cache-insight": { id: "cache-insight", title: "Cache", score: 0.5, displayValue: "13 KiB" },
          "document-title": { id: "document-title", title: "Title", score: 1 },
          diagnostics: { id: "diagnostics", title: "Diagnostics", score: 0, scoreDisplayMode: "informative" },
          "llms-txt": { id: "llms-txt", title: "llms.txt", score: 0 },
          "agent-tree": { id: "agent-tree", title: "Tree", score: 1 },
        },
      },
      "https://fallback.test/",
    )

    expect(result.url).toBe("https://example.com/")
    expect(result.categories).toEqual({ performance: 40, accessibility: 86, bestPractices: 96, seo: 100, agentic: 50 })
    expect(result.metrics.lcp).toBe("24.7 s")
    expect(result.failed.map((finding) => finding.id)).toEqual(["largest-contentful-paint", "llms-txt", "cache-insight"])
    expect(result.agentic).toEqual({ passed: 1, total: 2 })
  })
})

describe("parseHtml", () => {
  const base = new URL("https://www.example.ch/")

  test("reads what the checks need", () => {
    const page = parseHtml(
      `<html lang="de"><head><title>Feldhaus &amp; Partner</title>
      <meta name="generator" content="WordPress 5.4.25">
      <meta name="viewport" content="width=device-width">
      <meta property="og:image" content="/og.png">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":["LocalBusiness","Dentist"]}</script>
      </head><body><h1>Hi</h1>
      <a href="/about">About</a><a href="https://www.example.ch/about#team">Team</a>
      <a href="https://other.com/">Other</a><a href="#top">Top</a><a href="mailto:a@b.ch">Mail</a>
      <img src="http://cdn.example.ch/a.png"></body></html>`,
      base,
    )

    expect(page.title).toBe("Feldhaus & Partner")
    expect(page.lang).toBe("de")
    expect(page.cms).toBe("WordPress 5.4.25")
    expect(page.viewport).toBe(true)
    expect(page.ogImage).toBe(true)
    expect(page.types).toEqual(["LocalBusiness", "Dentist"])
    expect(page.h1).toBe(1)
    expect(page.links).toEqual(["https://www.example.ch/about"])
    expect(page.mixed).toBe(1)
  })

  test("finds a CMS from its asset paths", () => {
    expect(parseHtml(`<link href="/wp-content/themes/a.css">`, base).cms).toBe("WordPress")
    expect(parseHtml(`<script id="__NEXT_DATA__"></script>`, base).cms).toBe("Next.js")
  })

  test("spots the retired Universal Analytics", () => {
    expect(parseHtml(`<script>ga('create', 'UA-12345-1')</script>`, base).legacyAnalytics).toBe(true)
    expect(parseHtml(`<script>gtag('config', 'G-ABC123')</script>`, base).legacyAnalytics).toBe(false)
  })
})

describe("country", () => {
  test("names the country of a country-code domain", () => {
    expect(country("www.feldhaus-partner.ch")).toBe("CH")
    expect(country("shop.example.co.uk")).toBe("GB")
  })

  test("says nothing for generic and local hosts", () => {
    expect(country("example.com")).toBeUndefined()
    expect(country("startup.io")).toBeUndefined()
    expect(country("127.0.0.1")).toBeUndefined()
    expect(country("localhost")).toBeUndefined()
  })
})

describe("overallScore", () => {
  test("weighs Lighthouse 70% and the own checks 30%", () => {
    const lighthouse = mapReport(
      { categories: { performance: { score: 1 }, accessibility: { score: 1 }, seo: { score: 1 } } },
      "https://example.com/",
    )

    expect(overallScore(lighthouse, [])).toBe(100)
    expect(overallScore(lighthouse, [{ id: "no-https", group: "technical", severity: "critical" }])).toBe(93)
  })

  test("uses the own checks alone without Lighthouse", () => {
    expect(overallScore(undefined, [{ id: "no-csp", group: "technical", severity: "medium" }])).toBe(94)
  })
})

describe("normalize", () => {
  test("adds https to a bare domain", () => {
    expect(normalize("example.com")).toBe("https://example.com/")
    expect(normalize(" http://example.com/a ")).toBe("http://example.com/a")
  })

  test("rejects what is not a website", () => {
    expect(() => normalize("not a site")).toThrow()
    expect(() => normalize("ftp://example.com")).toThrow()
  })
})

describe("scanSite", () => {
  test("reports the page's facts and its findings", async () => {
    const url = await site({
      "/": {
        headers: { server: "nginx" },
        body: `<html><head><title>Home</title></head><body><a href="/ok">ok</a><a href="/gone">gone</a></body></html>`,
      },
      "/ok": { body: "ok" },
    })
    const result = await scanSite({ url, local: true, signal: new AbortController().signal })
    const ids = result.checks.map((check) => check.id)

    expect(result.technical).toMatchObject({ status: 200, https: false, server: "nginx", links: 2, title: "Home" })
    expect(result.checks.find((check) => check.id === "broken-links")?.values).toMatchObject({ count: 1 })
    expect(ids).toEqual(expect.arrayContaining(["no-viewport", "no-description", "no-structured-data", "no-h1"]))
    // Hosting decides HTTPS and the security headers, so the project's own dev server skips them.
    expect(ids).not.toContain("no-https")
    expect(ids).not.toContain("no-csp")
  })

  test("checks HTTPS and the security headers for a live site", async () => {
    const url = await site({ "/": { body: "<html><head><title>x</title></head></html>" } })
    const result = await scanSite({ url, local: false, signal: new AbortController().signal })

    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["no-https", "no-csp", "no-clickjacking", "no-robots", "no-sitemap"]),
    )
  })

  test("finds the well-known files a single-page app does not really have", async () => {
    const spa = "<html><head><title>app</title></head></html>"
    const url = await site({ "/": { body: spa }, "/llms.txt": { body: spa } })
    const result = await scanSite({ url, local: false, signal: new AbortController().signal })

    expect(result.checks.map((check) => check.id)).toContain("no-llms-txt")
  })
})
