import { describe, expect, test } from "bun:test"
import { publicRequest } from "@opencode-ai/server/authentication"

describe("publicRequest", () => {
  test("shared session data is readable without signing in", () => {
    expect(publicRequest("GET", "/global/share/amURBFc8/data")).toBe(true)
  })

  test("only that read is public", () => {
    expect(publicRequest("POST", "/global/share/amURBFc8/data")).toBe(false)
    expect(publicRequest("GET", "/global/share/amURBFc8")).toBe(false)
    expect(publicRequest("GET", "/global/share/a/b/data")).toBe(false)
    expect(publicRequest("GET", "/global/config")).toBe(false)
  })
})
