import { describe, expect, test } from "bun:test"
import { sanitizeJson } from "@opencode-ai/core/util/json"

describe("sanitizeJson", () => {
  test("strips NUL bytes from strings", () => {
    expect(sanitizeJson("a\u0000b\u0000c")).toBe("abc")
  })

  test("sanitizes nested strings in objects and arrays", () => {
    const input = { a: ["x\u0000", { b: "y\u0000" }], n: 1, flag: true, none: null }
    expect(sanitizeJson(input)).toEqual({ a: ["x", { b: "y" }], n: 1, flag: true, none: null })
  })

  test("replaces unpaired surrogates with the replacement character", () => {
    expect(sanitizeJson("\uD800")).toBe("\uFFFD")
    expect(sanitizeJson("a\uDC00b")).toBe("a\uFFFDb")
  })

  test("keeps valid surrogate pairs intact", () => {
    expect(sanitizeJson("😀")).toBe("😀")
  })

  test("leaves non-string primitives untouched", () => {
    expect(sanitizeJson(42)).toBe(42)
    expect(sanitizeJson(null)).toBeNull()
    expect(sanitizeJson(undefined)).toBeUndefined()
  })
})
