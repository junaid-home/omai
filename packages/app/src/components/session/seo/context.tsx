// The SEO tool's copy in the app's language, with English for anything a language does not have yet, plus the
// formatting locale and toasts. The tool owns its copy, like the panel it was ported from.

import { createContext, createResource, useContext, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import en from "./i18n/en"

type Params = Record<string, string | number>

type Dictionary = Partial<Record<keyof typeof en, string>>

const LOCALES: Record<string, () => Promise<{ default: Dictionary }>> = {
  de: () => import("./i18n/de"),
}

function createSeo() {
  const language = useLanguage()
  const [dict] = createResource(
    () => language.locale(),
    (locale) => LOCALES[locale]?.().then((module) => module.default) ?? Promise.resolve({}),
    { initialValue: {} },
  )
  const fill = (text: string, params: Params = {}) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  const t = (key: string, params?: Params) => {
    const english: Record<string, string> = en
    const local: Record<string, string | undefined> = dict.latest ?? {}

    return fill(local[key] ?? english[key] ?? key, params)
  }

  return {
    t,
    // The language's plural category when the copy has it, else "other" (English has only "one" and "other").
    plural: (key: string, count: number, params?: Params) => {
      const english: Record<string, string> = en
      const category = `${key}.${new Intl.PluralRules(language.intl()).select(count)}`

      return t(category in english ? category : `${key}.other`, { count, ...params })
    },
    locale: { locale: () => language.intl() },
    toast: {
      show: (input: { variant: "error"; title: string }) => showToast({ variant: input.variant, title: input.title }),
    },
  }
}

type Seo = ReturnType<typeof createSeo>

const SeoContext = createContext<Seo>()

export function SeoProvider(props: { children: JSX.Element }) {
  return <SeoContext.Provider value={createSeo()}>{props.children}</SeoContext.Provider>
}

export function useSeo() {
  const seo = useContext(SeoContext)

  if (!seo) throw new Error("useSeo must be used inside SeoProvider")

  return seo
}
