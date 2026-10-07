import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { googleCredentials, googleUsernameBase } from "../../src/server/routes/instance/httpapi/handlers/auth"

const KEYS = [
  "OPENCODE_AUTH_MODE",
  "OPENCODE_STORAGE_MODE",
  "OPENCODE_DATABASE_URL",
  "OPENCODE_DATABASE_URL_FILE",
  "OPENCODE_PUBLIC_URL",
  "OPENCODE_GOOGLE_CLIENT_ID",
  "OPENCODE_GOOGLE_CLIENT_SECRET",
  "OPENCODE_GOOGLE_CLIENT_ID_FILE",
  "OPENCODE_GOOGLE_CLIENT_SECRET_FILE",
]
const environment = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of KEYS) {
    environment.set(key, process.env[key])
    delete process.env[key]
  }
})
afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environment.clear()
})

describe("googleUsernameBase", () => {
  test("strips punctuation from the email local part", () => {
    expect(googleUsernameBase("first.last@example.com")).toBe("firstlast")
    expect(googleUsernameBase("user+tag@example.com")).toBe("usertag")
  })

  test("keeps underscores and hyphens and starts with an alphanumeric", () => {
    expect(googleUsernameBase("user_name-2@example.com")).toBe("user_name-2")
    expect(googleUsernameBase("_lead@example.com")).toBe("u_lead")
  })

  test("pads short names to a valid username", () => {
    const name = googleUsernameBase("ab@example.com")
    expect(name.startsWith("ab")).toBe(true)
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/)
  })

  test("produces a valid username for empty or non-ascii local parts", () => {
    for (const local of ["", "日本語", "@@"]) {
      expect(googleUsernameBase(`${local}@example.com`)).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/)
    }
  })

  test("caps the length at 24", () => {
    expect(googleUsernameBase(`${"a".repeat(40)}@example.com`).length).toBe(24)
  })
})

describe("googleCredentials", () => {
  test("returns credentials in local mode when configured", () => {
    process.env.OPENCODE_AUTH_MODE = "local"
    process.env.OPENCODE_PUBLIC_URL = "http://localhost:3000"
    process.env.OPENCODE_GOOGLE_CLIENT_ID = "client-id"
    process.env.OPENCODE_GOOGLE_CLIENT_SECRET = "client-secret"
    expect(googleCredentials()).toEqual({
      clientID: "client-id",
      clientSecret: "client-secret",
      origin: "http://localhost:3000",
    })
  })

  test("stays disabled in local mode without a public origin", () => {
    process.env.OPENCODE_AUTH_MODE = "local"
    process.env.OPENCODE_GOOGLE_CLIENT_ID = "client-id"
    process.env.OPENCODE_GOOGLE_CLIENT_SECRET = "client-secret"
    expect(googleCredentials()).toBeUndefined()
  })

  test("stays disabled without credentials", () => {
    process.env.OPENCODE_AUTH_MODE = "central"
    process.env.OPENCODE_PUBLIC_URL = "https://app.example.test"
    expect(googleCredentials()).toBeUndefined()
  })

  test("returns credentials in central mode when configured", () => {
    process.env.OPENCODE_AUTH_MODE = "central"
    process.env.OPENCODE_PUBLIC_URL = "https://app.example.test"
    process.env.OPENCODE_GOOGLE_CLIENT_ID = "client-id"
    process.env.OPENCODE_GOOGLE_CLIENT_SECRET = "client-secret"
    expect(googleCredentials()).toEqual({
      clientID: "client-id",
      clientSecret: "client-secret",
      origin: "https://app.example.test",
    })
  })
})
