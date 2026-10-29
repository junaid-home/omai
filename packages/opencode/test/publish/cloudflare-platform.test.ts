import { describe, expect, test } from "bun:test"
import { CloudflarePlatform } from "../../src/publish/cloudflare-platform"

const host = (status: string, ssl: string) => ({ id: "1", hostname: "a.b", status, ssl: { status: ssl } })

describe("CloudflarePlatform.domainStatus", () => {
  test("active only when hostname and ssl are active", () => {
    expect(CloudflarePlatform.domainStatus(host("active", "active"))).toBe("active")
    expect(CloudflarePlatform.domainStatus(host("pending", "pending_validation"))).toBe("pending")
    expect(CloudflarePlatform.domainStatus(host("active", "pending_validation"))).toBe("pending")
  })

  test("error states", () => {
    expect(CloudflarePlatform.domainStatus(host("blocked", "active"))).toBe("error")
    expect(CloudflarePlatform.domainStatus(host("moved", "active"))).toBe("error")
    expect(CloudflarePlatform.domainStatus(host("deleted", "active"))).toBe("error")
    expect(CloudflarePlatform.domainStatus(host("pending", "validation_timed_out"))).toBe("error")
  })
})

describe("CloudflarePlatform.isSaasDisabled", () => {
  test("detects SaaS-disabled codes", () => {
    expect(CloudflarePlatform.isSaasDisabled({ success: false, errors: [{ code: 1404, message: "No quota" }] })).toBe(
      true,
    )
    expect(CloudflarePlatform.isSaasDisabled({ success: false, errors: [{ code: 1456, message: "x" }] })).toBe(true)
    expect(CloudflarePlatform.isSaasDisabled({ success: false, errors: [{ code: 1000, message: "x" }] })).toBe(false)
    expect(CloudflarePlatform.isSaasDisabled("garbage")).toBe(false)
  })
})

describe("CloudflarePlatform.scriptPresent", () => {
  test("only a non-null script object counts", () => {
    expect(CloudflarePlatform.scriptPresent({ dispatch_namespace: "ns", script: null })).toBe(false)
    expect(CloudflarePlatform.scriptPresent({ dispatch_namespace: "ns", script: { id: "x" } })).toBe(true)
    expect(CloudflarePlatform.scriptPresent(undefined)).toBe(false)
  })
})
