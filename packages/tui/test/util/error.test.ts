import { describe, expect, test } from "bun:test"
import { Cause } from "effect"
import { errorCause, errorData, errorFormat, errorMessage, errorMessageWithCause } from "../../src/util/error"

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")

    const data = errorData(err)
    expect(data.type).toBe("Error")
    expect(data.message).toBe("boom")
    expect(String(data.formatted)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")

    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")
  })

  test("never returns bare {} for opaque object errors", () => {
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })

  test("appends the cause chain when the message hides it", () => {
    const err = new Error("Failed to acquire connection", { cause: new Error("timeout exceeded when trying to connect") })
    expect(errorMessageWithCause(err)).toBe("Failed to acquire connection\nCaused by: timeout exceeded when trying to connect")
    expect(errorMessage(err)).toBe("Failed to acquire connection")
  })

  test("unwraps Effect causes so tagged errors keep their reason", () => {
    const err = Object.assign(new Error("Failed query: select 1\nparams: []"), {
      cause: Cause.fail(new Error("timeout exceeded when trying to connect")),
    })
    expect(errorMessageWithCause(err)).toBe(
      "Failed query: select 1\nparams: []\nCaused by: timeout exceeded when trying to connect",
    )
    expect(errorCause(err)).toBeInstanceOf(Error)
  })

  test("skips causes that repeat the message", () => {
    expect(errorMessageWithCause(new Error("boom", { cause: new Error("boom") }))).toBe("boom")
    expect(errorMessageWithCause(new Error("no cause"))).toBe("no cause")
  })

  test("keeps walking when a wrapper repeats its message", () => {
    const root = new Error("timeout exceeded when trying to connect")
    const reason = Object.assign(new Error("Failed to acquire connection"), { cause: root })
    const wrapper = Object.assign(new Error("Failed to acquire connection"), { cause: reason })
    const err = Object.assign(new Error("Failed query: select 1\nparams: []"), { cause: Cause.fail(wrapper) })
    expect(errorMessageWithCause(err)).toBe(
      "Failed query: select 1\nparams: []\nCaused by: Failed to acquire connection\nCaused by: timeout exceeded when trying to connect",
    )
  })
})
