import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PlatformName } from "../../src/publish/platform-name"

describe("PlatformName", () => {
  test("slug", () => {
    expect(PlatformName.slug("My Shop")).toBe("my-shop")
    expect(PlatformName.slug("  --Hello__World!! ")).toBe("hello-world")
    expect(PlatformName.slug("日本語")).toBe("site")
    expect(PlatformName.slug("a".repeat(60))).toHaveLength(40)
  })

  test("withSuffix", () => {
    expect(PlatformName.withSuffix("a".repeat(40))).toMatch(/^a{35}-[a-z0-9]{4}$/)
    expect(PlatformName.withSuffix("shop")).toMatch(/^shop-[a-z0-9]{4}$/)
  })

  test("choose", async () => {
    expect(await Effect.runPromise(PlatformName.choose("App", () => Effect.succeed(false)))).toMatch(
      /^app-[a-z0-9]{4}$/,
    )
    expect(await Effect.runPromise(PlatformName.choose("my shop", (n) => Effect.succeed(n === "my-shop")))).toMatch(
      /^my-shop-[a-z0-9]{4}$/,
    )
    expect(await Effect.runPromise(PlatformName.choose("my shop", () => Effect.succeed(false)))).toBe("my-shop")
  })

  test("choose fails after exhausting attempts", async () => {
    const result = await Effect.runPromise(Effect.flip(PlatformName.choose("x", () => Effect.succeed(true))))
    expect(result).toBeInstanceOf(Error)
  })

  test("resolveScript", () => {
    expect(PlatformName.resolveScript("my-shop.omai.ch", "omai.ch")).toBe("my-shop")
    expect(PlatformName.resolveScript("MY-SHOP.omai.ch", "omai.ch")).toBe("my-shop")
    expect(PlatformName.resolveScript("omai.ch", "omai.ch")).toBeUndefined()
    expect(PlatformName.resolveScript("a.b.omai.ch", "omai.ch")).toBeUndefined()
    expect(PlatformName.resolveScript("www.omai.ch", "omai.ch")).toBeUndefined()
    expect(PlatformName.resolveScript("shop.example.com", "omai.ch")).toBeUndefined()
  })

  test("isHostname", () => {
    expect(PlatformName.isHostname("app.example.com")).toBe(true)
    expect(PlatformName.isHostname("a-b.co")).toBe(true)
    expect(PlatformName.isHostname("example")).toBe(false)
    expect(PlatformName.isHostname("-bad.example.com")).toBe(false)
    expect(PlatformName.isHostname("bad-.example.com")).toBe(false)
    expect(PlatformName.isHostname("bad_name.example.com")).toBe(false)
    expect(PlatformName.isHostname("a..com")).toBe(false)
    expect(PlatformName.isHostname("https://example.com")).toBe(false)
    expect(PlatformName.isHostname(`${"a".repeat(64)}.com`)).toBe(false)
    expect(PlatformName.isHostname(`${"a".repeat(63)}.com`)).toBe(true)
    expect(PlatformName.isHostname(Array(64).fill("abc").join("."))).toBe(false)
  })

  test("claimOutcome", () => {
    expect(PlatformName.claimOutcome("omai-project-a", "omai-project-a")).toBe("ours")
    expect(PlatformName.claimOutcome("omai-project-b", "omai-project-a")).toBe("taken")
    expect(PlatformName.claimOutcome(undefined, "omai-project-a")).toBe("unknown")
    expect(PlatformName.claimOutcome("something", "omai-project-a")).toBe("unknown")
  })
})
