import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockAuthUser, mockCorsHeaders } from "../utils/mock-server-contract"

test("verified session mounts a usable composer inside its command providers", async ({ page }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    onMessages: (request) => requests.push(request.sessionID),
  })
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel("Server save status")).toHaveCount(0)
  await prompt.fill("Draft stays editable after verified startup")
  await expect(prompt).toContainText("Draft stays editable after verified startup")
  await expect.poll(() => requests.includes(fixture.targetID)).toBe(true)
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
  await expect(page.getByText("Connecting to your server…", { exact: true })).toHaveCount(0)
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  await expect(page.locator(".settings-v2-dialog")).toBeVisible()
  expect(errors).toEqual([])
})

test("central signup keeps the original fields and sends a cleaned fragment invitation", async ({ page }) => {
  const submissions: Record<string, string>[] = []
  await mockOpenCodeServer(page, {
    mode: "central",
    authenticated: false,
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/auth/signup", async (route) => {
    submissions.push(route.request().postDataJSON())
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: mockCorsHeaders(),
      body: JSON.stringify({ error: "Please retry signup" }),
    })
  })
  await page.goto("/signup-secret-route#invite=signup-test-token")
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/signup-secret-route$/)
  await expect(page.getByLabel("Invitation code")).toHaveCount(0)
  await expect(page.locator("form input")).toHaveCount(4)
  await page.getByLabel("Username", { exact: true }).fill("newuser")
  await page.getByLabel("Email", { exact: true }).fill("newuser@example.test")
  await page.getByLabel("Password", { exact: true }).fill("signup-password")
  await page.getByLabel("Confirm Password", { exact: true }).fill("signup-password")
  await page.locator('button[type="submit"]').click()
  await expect(page.getByText("Please retry signup", { exact: true })).toBeVisible()
  await page.locator('button[type="submit"]').click()
  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions.map((body) => body.inviteToken)).toEqual(["signup-test-token", "signup-test-token"])
  expect(await page.evaluate(() => location.hash)).toBe("")
})

test("central save errors recover silently without losing the draft", async ({ page }) => {
  let unavailable = true
  let failedWrites = 0
  const writes: string[] = []
  await mockOpenCodeServer(page, {
    mode: "central",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    onStateWrite: (write) => {
      if (write.namespace === "drafts" && write.value) writes.push(write.value)
    },
  })
  await page.route("**/user-state", async (route) => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().namespace === "drafts" && unavailable) {
      failedWrites++
      await route.fulfill({ status: 503, headers: mockCorsHeaders(), body: "Unavailable" })
      return
    }
    await route.fallback()
  })
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeVisible()
  await prompt.fill("Draft survives unavailable storage")
  await expect.poll(() => failedWrites > 0).toBe(true)
  await expect(prompt).toContainText("Draft survives unavailable storage")
  await expect(page.getByLabel("Server save status")).toHaveCount(0)
  await expect(page.locator('[data-component="toast-v2"]').filter({ hasText: "Not saved" })).toHaveCount(0)
  unavailable = false
  await expect
    .poll(() => writes.some((value) => value.includes("Draft survives unavailable storage")), { timeout: 15_000 })
    .toBe(true)
  await page.reload()
  await expect(prompt).toContainText("Draft survives unavailable storage")
})

test("central conflicts resolve silently in favor of this tab", async ({ page }) => {
  const attempts: { expectedRevision?: number; value?: string | null }[] = []
  let conflicted = false
  await mockOpenCodeServer(page, {
    mode: "central",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/user-state", async (route) => {
    const request = route.request()
    const body = request.method() === "PUT" ? request.postDataJSON() : undefined
    if (body?.namespace === "drafts") {
      attempts.push(body)
      if (!conflicted) {
        conflicted = true
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: mockCorsHeaders(),
          body: JSON.stringify({ revision: 1, value: "Other browser draft" }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: mockCorsHeaders(),
        body: JSON.stringify({ revision: 2, value: body.value }),
      })
      return
    }
    await route.fallback()
  })
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeVisible()
  await prompt.fill("This browser draft")
  await expect.poll(() => conflicted).toBe(true)
  await expect(
    page.locator('[data-component="toast-v2"]').filter({ hasText: "Changed in another browser" }),
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Compare versions" })).toHaveCount(0)
  await expect
    .poll(() => attempts.some((body) => body.expectedRevision === 1 && body.value?.includes("This browser draft")), {
      timeout: 15_000,
    })
    .toBe(true)
  await expect(prompt).toContainText("This browser draft")
})

test("unverified bootstrap reuses the original error page without local persistence fallback", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/auth/config", (route) =>
    route.fulfill({ status: 503, headers: mockCorsHeaders(), body: "Unavailable" }),
  )
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible()
  await expect(page.getByText("Connecting to your server…", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("opencode.")))).toEqual([])
})

test("matching legacy browser data requires review and confirmation before import", async ({ page }) => {
  const imported: string[] = []
  await mockOpenCodeServer(page, {
    mode: "central",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    onStateWrite: (write) => {
      if (write.value?.includes("legacy-import-marker")) imported.push(write.value)
    },
  })
  await page.addInitScript((user) => {
    localStorage.setItem("omai_auth_user", JSON.stringify(user))
    localStorage.setItem("opencode.global.dat:prompt-history", JSON.stringify({ entries: ["legacy-import-marker"] }))
  }, mockAuthUser)
  await page.goto("/projects")
  const toast = page.locator('[data-component="toast-v2"]').filter({ hasText: "Previous browser data" })
  await expect(toast).toBeVisible()
  expect(imported).toEqual([])
  await toast.getByRole("button", { name: "Review", exact: true }).click()
  expect(imported).toEqual([])
  await page.getByRole("dialog").getByRole("button", { name: "Import browser data", exact: true }).click()
  await expect.poll(() => imported.length).toBe(1)
  expect(await page.evaluate(() => localStorage.getItem("opencode.global.dat:prompt-history"))).toBeNull()
})

test("central session saves its real composer draft to versioned server state", async ({ page }) => {
  const errors: string[] = []
  const writes: { namespace: string; value: string | null }[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    mode: "central",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    onStateWrite: (write) => writes.push(write),
  })
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeVisible({ timeout: 30_000 })
  await prompt.fill("Central draft survives browser reload")
  await expect
    .poll(() =>
      writes.some(
        (write) => write.namespace === "drafts" && write.value?.includes("Central draft survives browser reload"),
      ),
    )
    .toBe(true)
  await page.reload()
  await expect(prompt).toContainText("Central draft survives browser reload")
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
  expect(errors).toEqual([])
})

test("unauthenticated central startup renders login without durable state writes", async ({ page }) => {
  const errors: string[] = []
  const writes: unknown[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    mode: "central",
    authenticated: false,
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    onStateWrite: (write) => writes.push(write),
  })
  await page.goto("/projects")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel("Username or email")).toBeVisible()
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})
