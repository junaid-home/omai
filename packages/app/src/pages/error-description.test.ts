import { describe, expect, test } from "bun:test"
import { errorDescriptionKey, isNotFoundError } from "./error-description"

describe("error description", () => {
  test("describes local server startup errors", () => {
    expect(errorDescriptionKey(Object.assign(new Error("migration failed"), { localServerStartup: true }))).toBe(
      "error.page.description.localServerStartup",
    )
  })

  test("uses the generic description for other errors", () => {
    expect(errorDescriptionKey(new Error("unknown"))).toBe("error.page.description")
    expect(errorDescriptionKey(Object.assign(new Error("unknown"), { localServerStartup: false }))).toBe(
      "error.page.description",
    )
  })
})

describe("isNotFoundError", () => {
  test("recognizes a client error whose cause carries a 404", () => {
    const error = new Error("Not found", { cause: { body: { error: "Not found" }, status: 404 } })
    expect(isNotFoundError(error)).toBe(true)
    expect(isNotFoundError(new Error("wrapped", { cause: error }))).toBe(true)
  })

  test("leaves other failures to the error page", () => {
    expect(isNotFoundError(new Error("boom", { cause: { status: 500 } }))).toBe(false)
    expect(isNotFoundError(new Error("network error"))).toBe(false)
    expect(isNotFoundError("Not found")).toBe(false)
  })
})
