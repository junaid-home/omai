import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createComponent, createContext, createRoot, getOwner, useContext } from "solid-js"
import { ServerScope } from "@/utils/server-scope"

let SeoView: typeof import("@/components/session/seo/view")

const storage: AsyncStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

// Stands in for the app's Platform provider and fails the same way when a reader is outside it.
const Platform = createContext<{ platform: "desktop"; storage: () => AsyncStorage }>()

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => {
      const value = useContext(Platform)
      if (!value) throw new Error("Platform context must be used within a context provider")
      return value
    },
  }))

  SeoView = await import("@/components/session/seo/view")
})

const deps = {
  report: () => Promise.reject(new Error("not used")),
  ensurePreview: () => Promise.resolve(),
  pdf: () => Promise.reject(new Error("not used")),
  prompt: () => Promise.resolve(),
  abort: () => Promise.resolve(),
  t: (key: string) => key,
  locale: () => "en",
}

describe("SEO audit view", () => {
  // The view lives in a root of its own so an audit outlives the tab, yet its history store reads the storage
  // platform from context. Opening the SEO tab crashed the app when that root dropped the tab's contexts.
  test("keeps the tab's contexts and one view per project", () => {
    const views = createRoot((dispose) => {
      const result: ReturnType<typeof SeoView.auditView>[] = []
      createComponent(Platform.Provider, {
        value: { platform: "desktop", storage: () => storage },
        get children() {
          const project = { scope: ServerScope.local, directory: "/tmp/seo-view-test" }
          result.push(SeoView.auditView(project, deps, getOwner()), SeoView.auditView(project, deps, getOwner()))
          return undefined
        },
      })
      dispose()
      return result
    })

    expect(views).toHaveLength(2)
    expect(views[0]).toBe(views[1])
    expect(views[0]?.report()).toBeUndefined()
    expect(views[0]?.state.status.history).toEqual([])
  })
})
