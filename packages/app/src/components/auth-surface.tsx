import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

export function AuthSurface(props: { children: JSX.Element }) {
  const language = useLanguage()
  return (
    <div data-component="auth-surface">
      <section class="auth-panel" data-slot="auth-form-panel">
        <a class="auth-wordmark" href="/" aria-label="O M A I +">
          <span class="auth-wordmark-text">O M A I</span>
          <span class="auth-wordmark-plus" aria-hidden="true">
            +
          </span>
        </a>

        <div class="auth-panel-body">{props.children}</div>

        <div class="auth-panel-foot">
          <p class="auth-footnote">{language.t("auth.login.footer")}</p>
          <LanguagePill />
        </div>
      </section>

      <aside class="auth-aside" aria-hidden="true">
        <span class="auth-aside-stripes" />
        <span class="auth-aside-glow" />
        <div class="auth-aside-content">
          <p class="auth-aside-eyebrow">{language.t("auth.marketing.eyebrow")}</p>
          <h2 class="auth-aside-title">{language.t("auth.marketing.title")}</h2>
          <p class="auth-aside-subtitle">{language.t("auth.marketing.subtitle")}</p>
        </div>
      </aside>
    </div>
  )
}

export function AuthHead(props: { eyebrow?: string; title: string; subtitle: string }) {
  return (
    <div class="auth-head">
      <Show when={props.eyebrow}>
        <p class="auth-eyebrow">{props.eyebrow}</p>
      </Show>
      <h1 class="auth-title">{props.title}</h1>
      <p class="auth-subtitle">{props.subtitle}</p>
    </div>
  )
}

function LanguagePill() {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  const onClickDocument = (event: MouseEvent) => {
    if (!root?.contains(event.target as Node)) setOpen(false)
  }
  document.addEventListener("mousedown", onClickDocument)
  onCleanup(() => document.removeEventListener("mousedown", onClickDocument))

  return (
    <div class="auth-lang" ref={root}>
      <button
        type="button"
        class="auth-lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Icon name="wheel-globe" class="auth-lang-icon" />
        <span class="auth-lang-current">{language.label(language.locale())}</span>
        <Icon name="chevron-down" class="auth-lang-chevron" />
      </button>
      <Show when={open()}>
        <ul class="auth-lang-menu" role="listbox">
          <For each={language.locales}>
            {(locale) => (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={language.locale() === locale}
                  class="auth-lang-option"
                  data-active={language.locale() === locale}
                  onClick={() => {
                    language.setLocale(locale)
                    setOpen(false)
                  }}
                >
                  {language.label(locale)}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
