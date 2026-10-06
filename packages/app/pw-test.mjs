import { chromium } from "/Users/junaidjaved/Desktop/opencode-postgresql-old/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs"

const CA = "/tmp/omai-dev/omai.local.crt"
const APP = "https://localhost:8443"
const SID = "ses_ef41f1042ffef7iRFmrZGR5XSq"

const log = (...a) => console.log(...a)

const browser = await chromium.launch()
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })

const reqs = []
ctx.on("response", (r) => {
  const u = r.url()
  if (u.includes("preview.localhost") || u.includes("/static/") || u.includes("ticket"))
    reqs.push(`${r.status()} ${r.request().method()} ${u.slice(0, 130)}`)
})

const page = await ctx.newPage()
page.on("console", (m) => {
  const t = m.text()
  if (/cookie|third.party|blocked|SameSite|frame/i.test(t)) log("  [console]", t.slice(0, 160))
})

await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" })
await page.fill('input[name="usernameOrEmail"], input[type="text"]', "minikube").catch(() => {})
await page.fill('input[type="password"]', "correct-horse-battery").catch(() => {})
await page.click('button[type="submit"]').catch(() => {})
await page.waitForTimeout(3000)
log("logged in, url =", page.url())

// Reproduce the real thing: the app hosts the preview in an IFRAME on APP origin,
// while the preview content is served from preview.localhost -> cross-site iframe.
const target = await page.evaluate(async (app) => {
  const r = await fetch(`${app}/global/preview/static`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app },
    credentials: "include",
    body: JSON.stringify({ directory: "/mnt/omai-central/workspaces/demo", html: "<h1 id=x>PREVIEW OK</h1>" }),
  })
  return r.json()
}, APP)
log("minted:", target.url)

const holder = `${APP}/projects`
await page.goto(holder, { waitUntil: "domcontentloaded" })
await page.evaluate((u) => {
  const f = document.createElement("iframe")
  f.id = "pf"
  f.style.cssText = "width:800px;height:400px;border:2px solid red"
  f.src = u
  document.body.appendChild(f)
}, target.url)

await page.waitForTimeout(6000)
const frame = page.frames().find((f) => f.url().includes("preview.localhost"))
log("\niframe final url :", frame ? frame.url() : "(no frame on preview origin)")
log("iframe body text :", JSON.stringify(frame ? (await frame.locator("body").innerText().catch(() => "<unreadable>")).slice(0, 80) : null))
const cookies = await ctx.cookies("https://preview.localhost:8443")
log("preview cookies  :", cookies.length ? cookies.map((c) => `${c.name} sameSite=${c.sameSite}`).join(", ") : "(NONE — blocked)")

log("\nrequests:")
for (const r of [...new Set(reqs)]) log("  " + r)

await browser.close()
