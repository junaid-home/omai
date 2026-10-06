import { afterEach, describe, expect, test } from "bun:test"
import { matchingBrowserState } from "../src/utils/central-import"
import { captureSignupInvitation, signupInvitation } from "../src/utils/signup-invitation"

afterEach(() => captureSignupInvitation({ url: "https://app.example.test/", replace: () => {} }))

describe("original signup form invitation adapter", () => {
  test("takes an invitation from the fragment, cleans the URL, and retains it for retry", () => {
    const replaced: string[] = []
    captureSignupInvitation({
      url: "https://app.example.test/signup-secret-route?language=de#invite=one-use-token&section=account",
      replace: (url) => replaced.push(url),
    })
    expect(replaced).toEqual(["https://app.example.test/signup-secret-route?language=de#section=account"])
    expect(signupInvitation()).toBe("one-use-token")
    expect(signupInvitation()).toBe("one-use-token")
  })

  test("does not consume invitations from other pages or query parameters", () => {
    for (const url of [
      "https://app.example.test/login#invite=token",
      "https://app.example.test/signup-secret-route?invite=token",
    ]) {
      const replaced: string[] = []
      captureSignupInvitation({ url, replace: (value) => replaced.push(value) })
      expect(signupInvitation()).toBeUndefined()
      expect(replaced).toEqual([])
    }
  })

  test("removes but rejects ambiguous, empty, oversized and control-character invitations", () => {
    for (const fragment of ["invite=", "invite=a&invite=b", "invite=a%0Ab", "invite=" + "a".repeat(513)]) {
      const replaced: string[] = []
      captureSignupInvitation({
        url: "https://app.example.test/signup-secret-route#" + fragment,
        replace: (url) => replaced.push(url),
      })
      expect(signupInvitation()).toBeUndefined()
      expect(replaced).toEqual(["https://app.example.test/signup-secret-route"])
    }
  })
})

function browserState(owner: unknown) {
  const values = new Map([
    ["omai_auth_user", JSON.stringify(owner)],
    ["omai_auth_token", "never-import-this"],
    ["settings.v3", '{"editor":{"fontSize":14}}'],
  ])
  const storage: Storage = {
    get length() {
      return values.size
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  }
  return storage
}

describe("explicit legacy browser import offer", () => {
  const user = { id: "alice-id", username: "alice", email: "alice@example.test" }

  test("requires both the verified account ID and username to match", () => {
    for (const owner of [null, { ...user, id: "bob-id" }, { ...user, username: "bob" }]) {
      expect(matchingBrowserState(user, browserState(owner))).toBeUndefined()
    }
    const source = browserState(user)
    const candidate = matchingBrowserState(user, source)!
    expect(candidate.length).toBe(1)
    expect(candidate.key(0)).toBe("settings.v3")
    expect(candidate.getItem("omai_auth_token")).toBeNull()
    expect(source.getItem("settings.v3")).not.toBeNull() // Offering never imports or deletes anything.
  })

  test("later browser edits are neither imported nor removed by the reviewed snapshot", () => {
    const source = browserState(user)
    const candidate = matchingBrowserState(user, source)!
    source.setItem("settings.v3", '{"editor":{"fontSize":20}}')
    expect(candidate.getItem("settings.v3")).toBe('{"editor":{"fontSize":14}}')
    candidate.removeItem("settings.v3")
    expect(source.getItem("settings.v3")).toBe('{"editor":{"fontSize":20}}')
  })

  test("unavailable browser storage does not block central startup", () => {
    expect(
      matchingBrowserState(user, () => {
        throw new Error("Storage denied")
      }),
    ).toBeUndefined()
  })
})
