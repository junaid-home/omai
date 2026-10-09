import { centralRuntime } from "@/utils/central-state"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { useFile } from "@/context/file"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { loadPreviewHtml } from "@/components/preview-helpers"
import { Icon } from "@opencode-ai/ui/icon"
import { getPreviewUrl, setPreviewUrl, normalizePreviewUrl } from "@/context/preview-lifecycle"
import { BrandLogo } from "@/components/brand-logo"
import { useVisualEditor } from "@/context/visual-editor"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

import { handleWheelPinch } from "@/utils/browser-zoom"
import { showToast } from "@/utils/toast"

function tryClickAnchor(iframe: HTMLIFrameElement | undefined, url: string): boolean {
  if (!iframe) return false
  try {
    const win = iframe.contentWindow
    const doc = iframe.contentDocument
    if (!win || !doc || win.location.origin !== window.location.origin) return false
    if (!url.startsWith(win.location.origin)) return false
    const desired = url.replace(win.location.origin, "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/"
    const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))
    for (const anchor of anchors) {
      try {
        const hrefPath = new URL(anchor.href, win.location.href).pathname.replace(/\/+$/, "") || "/"
        if (hrefPath === desired) {
          anchor.click()
          return true
        }
      } catch {}
    }
    return false
  } catch {
    return false
  }
}

function LivePreview(props: {
  url: string
  reloadKey: number
  onReady: () => void
  nav?: () => { url: string; nonce: number } | null
  onIframeLoaded?: () => void
  onUrlChange?: (url: string) => void
}) {
  let iframe: HTMLIFrameElement | undefined
  let initialUrl = props.url
  let currentUrl = props.url
  let ready = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const editor = useVisualEditor()

  createEffect(
    on(
      () => props.nav?.(),
      (nav, prev) => {
        if (!nav || nav.nonce === prev?.nonce) return
        if (!iframe) return
        const clicked = tryClickAnchor(iframe, nav.url)
        if (!clicked) {
          ready = false
          startPolling()
          iframe.src = nav.url
          props.onIframeLoaded?.()
          return
        }
        props.onIframeLoaded?.()
      },
    ),
  )

  const markReady = () => {
    if (ready) return
    ready = true
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
    props.onReady()
    if (iframe) {
      editor.setIframeRef(iframe)
    }
  }

  const pollReadyState = () => {
    try {
      const doc = iframe?.contentDocument
      if (doc && (doc.readyState === "complete" || doc.readyState === "interactive")) {
        markReady()
      }
    } catch {
      // cross-origin — rely on message/fallback
    }
  }

  const handleMessage = (e: MessageEvent) => {
    if (e.source !== iframe?.contentWindow || e.data?.type !== "preview-ready") return
    if (centralRuntime.get().mode === "central") {
      if (e.origin !== new URL(props.url).origin || typeof e.data.url !== "string") return
      const received = new URL(e.data.url)
      if (received.origin !== e.origin) return
      received.searchParams.delete("ticket")
      currentUrl = received.toString()
      props.onUrlChange?.(currentUrl)
    }
    markReady()
  }

  const startPolling = () => {
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
    pollTimer = setInterval(pollReadyState, 250)
    fallbackTimer = setTimeout(markReady, 4000)
  }

  const stopPolling = () => {
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
  }

  onMount(() => {
    window.addEventListener("message", handleMessage)
    if (iframe && initialUrl) {
      iframe.src = initialUrl
      startPolling()
    }
    onCleanup(() => {
      window.removeEventListener("message", handleMessage)
      stopPolling()
    })
  })

  onCleanup(() => {
    window.removeEventListener("message", handleMessage)
    stopPolling()
  })

  createEffect(
    on(
      () => props.url,
      (newUrl, prevUrl) => {
        if (newUrl && newUrl !== prevUrl && iframe) {
          ready = false
          startPolling()
          currentUrl = newUrl
          iframe.src = newUrl
        }
      },
    ),
  )

  createEffect(
    on(
      () => props.reloadKey,
      (_next, prev) => {
        if (prev === undefined || !iframe) return
        ready = false
        startPolling()
        try {
          iframe.contentWindow?.location.reload()
        } catch {
          iframe.src = currentUrl
        }
      },
    ),
  )

  return (
    <iframe
      ref={(el) => {
        iframe = el
        editor.setIframeRef(el)
        props.onIframeLoaded?.()
      }}
      src=""
      sandbox={
        centralRuntime.get().mode === "central"
          ? "allow-scripts allow-same-origin allow-forms allow-downloads"
          : undefined
      }
      class="w-full h-full border-0"
      title="Preview"
    />
  )
}

function StaticPreview(props: { html: string; nonce: number; onReady: () => void }) {
  let iframe: HTMLIFrameElement | undefined
  let ready = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const editor = useVisualEditor()

  const markReady = () => {
    if (ready) return
    ready = true
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
    props.onReady()
    if (iframe) {
      editor.setIframeRef(iframe)
    }
  }

  const pollReadyState = () => {
    try {
      const doc = iframe?.contentDocument
      if (doc && (doc.readyState === "complete" || doc.readyState === "interactive")) {
        markReady()
      }
    } catch {
      // cross-origin — rely on message/fallback
    }
  }

  const handleMessage = (e: MessageEvent) => {
    if (e.source === iframe?.contentWindow && e.data?.type === "preview-ready") markReady()
  }

  const startPolling = () => {
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
    pollTimer = setInterval(pollReadyState, 250)
    fallbackTimer = setTimeout(markReady, 4000)
  }

  const stopPolling = () => {
    clearInterval(pollTimer)
    clearTimeout(fallbackTimer)
  }

  onMount(() => {
    window.addEventListener("message", handleMessage)
    startPolling()
    onCleanup(() => {
      window.removeEventListener("message", handleMessage)
      stopPolling()
    })
  })

  onCleanup(() => {
    window.removeEventListener("message", handleMessage)
    stopPolling()
  })

  return (
    <iframe
      ref={(el) => {
        iframe = el
        editor.setIframeRef(el)
      }}
      srcdoc={props.html}
      sandbox={
        centralRuntime.get().mode === "central"
          ? "allow-scripts allow-same-origin allow-forms allow-downloads"
          : undefined
      }
      class="w-full h-full border-0"
      title="Preview"
    />
  )
}

type PreviewState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "live"; url: string }
  | { type: "static"; html: string }
  | { type: "error"; message: string }

function PreviewZoomOverlay(props: { active: () => boolean }) {
  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    handleWheelPinch(e.deltaY, e.deltaMode)
  }

  return (
    <div
      class="absolute inset-0 z-10 pointer-events-none"
      classList={{ "pointer-events-auto": props.active() }}
      onWheel={handleWheel}
    />
  )
}

function Mark(props: { multi: boolean; checked: boolean }) {
  return (
    <span
      class="mt-0.5 size-4 shrink-0 flex items-center justify-center transition-all duration-200 border rounded-full"
      classList={{
        "bg-accent-base border-accent-base": props.checked,
        "border-border-base": !props.checked,
      }}
    >
      <Show when={props.checked}>
        <svg viewBox="0 0 12 12" fill="none" class="size-2.5 text-white">
          <path
            d="M2.5 6.5L4.5 8.5L9.5 3.5"
            stroke="currentColor"
            stroke-width="2.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Show>
    </span>
  )
}

function PreviewQuestionPanel(props: { request: QuestionRequest; agentName?: string; onDone: () => void }) {
  const sdk = useSDK()
  const language = useLanguage()

  const questions = createMemo(() => props.request.questions)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    customOn: [] as boolean[],
    editing: false,
  })

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const multi = createMemo(() => question()?.multiple === true)
  const total = createMemo(() => questions().length)
  const last = createMemo(() => store.tab >= total() - 1)
  const input = () => store.custom[store.tab] ?? ""
  const on = () => store.customOn[store.tab] === true
  const answered = (i: number) => {
    if ((store.answers[i]?.length ?? 0) > 0) return true
    return store.customOn[i] === true && (store.custom[i] ?? "").trim().length > 0
  }
  const answeredCount = createMemo(() => questions().filter((_, i) => answered(i)).length)
  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("session.question.custom.placeholder")

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => sdk().client.question.reply({ requestID: props.request.id, answers }),
    onSuccess: () => props.onDone(),
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk().client.question.reject({ requestID: props.request.id }),
    onSuccess: () => props.onDone(),
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const picked = (label: string) => store.answers[store.tab]?.includes(label) ?? false

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const select = (label: string) => {
    if (sending()) return
    if (multi()) {
      setStore("editing", false)
      setStore("answers", store.tab, (current = []) => {
        if (current.includes(label)) return current.filter((item) => item !== label)
        return [...current, label]
      })
    } else {
      setStore("customOn", store.tab, false)
      setStore("editing", false)
      setStore("answers", store.tab, [label])
    }
  }

  const customToggle = () => {
    if (sending()) return

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
  }

  const customOpen = () => {
    if (sending()) return
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()
    if (last()) {
      replyMutation.mutate(questions().map((_, i) => store.answers[i] ?? []))
    } else {
      setStore("tab", store.tab + 1)
      setStore("editing", false)
    }
  }

  const reject = () => rejectMutation.mutate()

  const primaryEnabled = () => (last() ? answeredCount() === total() : answered(store.tab))

  return (
    <div class="w-full h-full flex flex-col overflow-hidden">
      <div class="h-1 bg-border-weak-base relative overflow-hidden shrink-0">
        <div
          class="h-full bg-accent-base transition-[width] duration-500 ease-out"
          style={{ width: `${total() === 0 ? 0 : (answeredCount() / total()) * 100}%` }}
        />
      </div>
      <div
        class="flex-1 overflow-y-auto relative no-scrollbar"
        style="background-color:var(--v2-background-bg-base,#f8f8f8);background-image:radial-gradient(circle,color-mix(in srgb,var(--v2-text-text-faint,rgba(0,0,0,0.25)) 40%,transparent) 0.8px,transparent 0.8px);background-size:24px 24px"
      >
        <div class="relative w-full max-w-lg mx-auto px-5 py-8">
          <div class="flex items-center gap-6 mb-9">
            <div class="flex items-center gap-3.5 shrink-0">
              <span class="relative inline-flex items-center justify-center shrink-0">
                <span
                  class="absolute inset-0 -m-2.5 rounded-full blur-xl opacity-50 pointer-events-none"
                  style="background:radial-gradient(circle,var(--v2-icon-icon-accent,rgba(10,74,138,0.4)),transparent 70%)"
                />
                <span
                  class="absolute inset-0 -m-1 rounded-[10px] opacity-30 blur-sm"
                  style="background:linear-gradient(135deg,rgba(10,74,138,0.25),rgba(56,189,248,0.12))"
                />
                <BrandLogo
                  size="small"
                  class="relative block rounded-[7px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08)]"
                />
              </span>
              <div class="min-w-0">
                <span
                  class="text-12-semibold uppercase tracking-[0.15em] block leading-none"
                  style="background:linear-gradient(135deg,color-mix(in srgb,var(--v2-accent-base,#0a4a8a) 60%,#000) 0%,var(--v2-accent-base,#0a4a8a) 35%,#38bdf8 100%);-webkit-background-clip:text;background-clip:text;color:transparent"
                >
                  {language.t("ui.tool.questions")}
                </span>
                <span class="text-11-medium text-text-base mt-1 block leading-none">
                  {language.t("session.question.answeredProgress", { answered: answeredCount(), total: total() })}
                </span>
              </div>
            </div>
            <div
              class="flex-1 h-px rounded-full"
              style="background:linear-gradient(90deg,var(--v2-accent-base,#0a4a8a),transparent)"
            />
            <span
              class="flex items-center gap-1.5 text-13-semibold shrink-0 px-3 py-1 rounded-lg truncate max-w-[160px]"
              style="border:1px solid color-mix(in srgb,var(--v2-accent-base,#0a4a8a) 20%,transparent);color:var(--v2-accent-base,#0a4a8a)"
              title={props.agentName ? `Model: ${props.agentName}` : undefined}
            >
              <svg viewBox="0 0 16 16" fill="none" class="size-3.5 shrink-0">
                <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
              </svg>
              {props.agentName ?? `${String(answeredCount()).padStart(2, "0")}/${String(total()).padStart(2, "0")}`}
            </span>
          </div>

          <div class="relative mb-6 pl-1">
            <div
              class="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
              style="background:linear-gradient(180deg,var(--v2-accent-base,#0a4a8a) 0%,color-mix(in srgb,var(--v2-accent-base,#0a4a8a) 25%,transparent) 100%)"
            />
            <div class="flex items-center gap-3 mb-1.5 ml-5">
              <h2
                class="text-16-medium leading-snug m-0 tracking-[-0.01em] pr-4"
                style="background:linear-gradient(135deg,color-mix(in srgb,var(--v2-accent-base,#0a4a8a) 60%,#000) 0%,var(--v2-accent-base,#0a4a8a) 35%,#38bdf8 100%);-webkit-background-clip:text;background-clip:text;color:transparent"
              >
                {question()?.question}
              </h2>
            </div>
            <p class="text-13-regular text-text-base ml-5 mt-0.5">
              {language.t(multi() ? "ui.question.multiHint" : "ui.question.singleHint")}
            </p>
          </div>

          <div class="flex flex-col gap-2">
            <For each={options()}>
              {(opt) => {
                const checked = () => picked(opt.label)
                return (
                  <button
                    type="button"
                    class="relative w-full flex bg-background-strong items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left cursor-pointer transition-all duration-200"
                    classList={{
                      "border-accent-base shadow-[0_0_0_1px_var(--v2-accent-base,#0a4a8a),0_2px_8px_-3px_var(--v2-accent-base,#0a4a8a)]":
                        checked(),
                      "border-border-base hover:border-border-strong hover:bg-background-weak shadow-sm": !checked(),
                    }}
                    disabled={sending()}
                    onClick={() => select(opt.label)}
                  >
                    <Mark multi={multi()} checked={checked()} />
                    <span class="flex-1 min-w-0">
                      <span class="text-14-medium break-words block leading-snug text-text-strong">{opt.label}</span>
                      <Show when={opt.description}>
                        <span class="text-12-regular text-text-base mt-0.5 leading-snug block">{opt.description}</span>
                      </Show>
                    </span>
                  </button>
                )
              }}
            </For>

            <Show
              when={store.editing}
              fallback={
                <button
                  type="button"
                  class="relative w-full flex bg-background-strong items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left cursor-pointer transition-all duration-200"
                  classList={{
                    "border-accent-base shadow-[0_0_0_1px_var(--v2-accent-base,#0a4a8a),0_2px_8px_-3px_var(--v2-accent-base,#0a4a8a)]":
                      on(),
                    "border-border-base hover:border-border-strong hover:bg-background-weak shadow-sm": !on(),
                  }}
                  disabled={sending()}
                  onClick={customOpen}
                >
                  <Mark multi={multi()} checked={on()} />
                  <span class="flex-1 min-w-0">
                    <span class="text-14-medium break-words block leading-snug text-text-strong">{customLabel()}</span>
                    <span class="text-12-regular text-text-base mt-0.5 leading-snug block">
                      {input() || customPlaceholder()}
                    </span>
                  </span>
                </button>
              }
            >
              <form
                class="relative w-full flex bg-background-strong items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-all duration-200"
                classList={{
                  "border-accent-base shadow-[0_0_0_1px_var(--v2-accent-base,#0a4a8a),0_2px_8px_-3px_var(--v2-accent-base,#0a4a8a)]":
                    on(),
                  "border-border-base": !on(),
                }}
                onSubmit={(e) => {
                  e.preventDefault()
                  commitCustom()
                }}
              >
                <button
                  type="button"
                  class="bg-transparent border-0 p-0 cursor-pointer"
                  disabled={sending()}
                  onClick={customToggle}
                >
                  <Mark multi={multi()} checked={on()} />
                </button>
                <span class="flex-1 min-w-0">
                  <span class="text-14-medium break-words block leading-snug text-text-strong">{customLabel()}</span>
                  <textarea
                    ref={focusCustom}
                    data-slot="question-custom-input"
                    placeholder={customPlaceholder()}
                    value={input()}
                    rows={1}
                    disabled={sending()}
                    class="w-full bg-transparent resize-none border-0 outline-none p-0 mt-0.5 text-12-regular text-text-strong placeholder:text-text-faint"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault()
                        setStore("editing", false)
                        return
                      }
                      if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                      if (e.key !== "Enter" || e.shiftKey) return
                      e.preventDefault()
                      commitCustom()
                    }}
                    onInput={(e) => {
                      customUpdate(e.currentTarget.value)
                      resizeInput(e.currentTarget)
                    }}
                  />
                </span>
              </form>
            </Show>
          </div>
        </div>
      </div>
      <div class="shrink-0 bg-[var(--v2-background-bg-base,#f8f8f8)] border-t border-[var(--v2-border-border-base,rgba(0,0,0,0.08))]">
        <div class="w-full max-w-lg mx-auto flex items-center justify-between gap-3 px-5 py-1">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-13-medium text-text-base bg-none border-0 cursor-pointer transition-all duration-150 hover:text-text-strong hover:bg-[var(--v2-overlay-simple-overlay-hover,var(--surface-base-hover))] active:bg-[var(--v2-overlay-simple-overlay-pressed,var(--surface-base-active))] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-base"
            disabled={sending()}
            onClick={reject}
          >
            <svg viewBox="0 0 14 14" fill="none" class="size-3.5 text-text-base">
              <path d="M4 4L10 10M10 4L4 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            {language.t("ui.common.dismiss")}
          </button>
          <div class="flex items-center gap-2">
            <Show when={store.tab > 0}>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 h-8 px-3 rounded-[8px] text-13-medium text-text-strong border bg-[var(--v2-background-bg-base,#f8f8f8)] cursor-pointer transition-all duration-150"
                style="border-color:var(--v2-border-border-base,rgba(0,0,0,0.08));box-shadow:var(--v2-elevation-button-neutral,0 1px 2px rgba(0,0,0,0.04))"
                classList={{
                  "hover:bg-[var(--v2-overlay-simple-overlay-hover,var(--surface-base-hover))] active:bg-[var(--v2-overlay-simple-overlay-pressed,var(--surface-base-active))]": true,
                  "opacity-35 cursor-not-allowed": sending(),
                }}
                disabled={sending()}
                onClick={() => setStore("tab", store.tab - 1)}
              >
                <svg viewBox="0 0 14 14" fill="none" class="size-3.5 text-text-base">
                  <path
                    d="M9 3L5 7L9 11"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                {language.t("ui.common.back")}
              </button>
            </Show>
            <button
              type="button"
              class="inline-flex items-center justify-center gap-2 h-8 px-3.5 rounded-md text-xs font-medium tracking-wide cursor-pointer transition-all duration-150 ease-in-out text-white disabled:cursor-not-allowed select-none hover:opacity-90 active:scale-[0.98]"
              style={
                sending() || !primaryEnabled()
                  ? "background: var(--v2-background-bg-layer-03, rgba(0, 0, 0, 0.06)); color: var(--v2-text-text-faint, rgba(0, 0, 0, 0.3));"
                  : "background:linear-gradient(135deg,color-mix(in srgb,var(--v2-accent-base,#0a4a8a) 60%,#000) 0%,var(--v2-accent-base,#0a4a8a) 35%,#38bdf8 100%); color: #ffffff;"
              }
              disabled={sending() || !primaryEnabled()}
              onClick={next}
            >
              <span>{last() ? language.t("ui.common.submit") : language.t("ui.common.next")}</span>
              <svg viewBox="0 0 14 14" fill="none" class="w-3.5 h-3.5">
                <path
                  d="M5 3L9 7L5 11"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PreviewPanel(props: {
  nonce: number
  reloadKey?: number
  isResizing?: boolean
  onPreviewReady?: (ready: boolean) => void
  questionRequest?: QuestionRequest
  onQuestionDone?: () => void
  agentName?: string
  deviceWidth?: number | null
  zoom?: number
  onUrlChange?: (url: string) => void
  control?: {
    navigate: (url: string) => void
    reload: () => void
    getIframe?: () => HTMLIFrameElement | undefined
    onLoad?: () => void
  }
}) {
  const file = useFile()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const language = useLanguage()
  const editor = useVisualEditor()
  const directory = createMemo(() => sdk().directory)

  createEffect(
    on(
      () => (editor.enabled() ? editor.bridgeError() : ""),
      (error) => {
        if (error) showToast({ title: language.t("common.requestFailed"), description: error, variant: "error" })
      },
    ),
  )

  const [state, setState] = createSignal<PreviewState>({ type: "idle" })
  const [phaseMessage, setPhaseMessage] = createSignal("")
  const [liveReloadKey, setLiveReloadKey] = createSignal(0)
  const [externalNav, setExternalNav] = createSignal<{ url: string; nonce: number } | null>(null)
  const [iframeReady, setIframeReady] = createSignal(false)
  const [iframeLoaded, setIframeLoaded] = createSignal(0)
  const [ctrlHeld, setCtrlHeld] = createSignal(false)
  const [frozenWidth, setFrozenWidth] = createSignal<number | null>(null)
  const [containerWidth, setContainerWidth] = createSignal(0)
  let containerRef: HTMLDivElement | undefined
  let containerObserver: ResizeObserver | undefined

  const fitScale = createMemo(() => {
    const cw = containerWidth()
    const dw = props.deviceWidth || 0
    if (cw <= 0 || dw <= 0) return undefined
    return cw / dw
  })

  const initContainerRef = (el: HTMLDivElement | undefined) => {
    containerObserver?.disconnect()
    containerObserver = undefined
    containerRef = el
    if (el) {
      containerObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width)
        }
      })
      containerObserver.observe(el)
    }
  }

  createEffect(() => {
    const s = liveUrl()
    if (s) props.onUrlChange?.(s)
  })

  onMount(() => {
    if (!props.control) return
    props.control.navigate = (url: string) => setExternalNav({ url, nonce: Date.now() })
    props.control.reload = reloadPreview
    props.control.getIframe = () => {
      try {
        const iframes = containerRef?.querySelectorAll("iframe")
        return iframes?.[0] as HTMLIFrameElement | undefined
      } catch {
        return undefined
      }
    }
  })

  createEffect(() => {
    if (iframeLoaded() > 0) props.control?.onLoad?.()
  })

  onCleanup(() => {
    containerObserver?.disconnect()
    stopPhasePolling()
    if (!props.control) return
    props.control.navigate = () => {}
    props.control.reload = () => {}
    props.control.getIframe = () => undefined
    props.control.onLoad = () => {}
  })

  createEffect(() => {
    if (props.isResizing && containerRef) {
      setFrozenWidth(containerRef.clientWidth)
    } else if (!props.isResizing) {
      setFrozenWidth(null)
    }
  })

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Control" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))
        setCtrlHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlHeld(false)
    }
    const blur = () => setCtrlHeld(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", blur)
    onCleanup(() => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", blur)
      setCtrlHeld(false)
    })
  })
  const liveUrl = createMemo(() => {
    const s = state()
    return s.type === "live" ? s.url : undefined
  })
  const staticHtml = createMemo(() => {
    const s = state()
    return s.type === "static" ? s.html : undefined
  })
  const showError = () => state().type === "error"
  const errorMessage = createMemo(() => {
    const s = state()
    return s.type === "error" ? s.message : ""
  })

  let phaseTimer: ReturnType<typeof setInterval> | undefined
  const stopPhasePolling = () => {
    if (phaseTimer) clearInterval(phaseTimer)
    phaseTimer = undefined
  }
  // The server exposes an install/start phase so a slow first run (installing
  // dependencies) shows progress instead of a static "Starting preview…".
  const startPhasePolling = (dir: string) => {
    stopPhasePolling()
    const tick = async () => {
      const response = await fetch(
        `${serverSDK().url}/global/preview/status?directory=${encodeURIComponent(dir)}`,
        { credentials: "include" },
      ).catch(() => undefined)
      if (!response?.ok) return
      const body = (await response.json().catch(() => undefined)) as { phase?: string; message?: string } | undefined
      if (!body) return
      const fallback =
        body.phase === "installing" ? "Installing dependencies…" : body.phase === "starting" ? "Starting dev server…" : ""
      const text = body.message || fallback
      if (text) setPhaseMessage(text)
    }
    void tick()
    phaseTimer = setInterval(tick, 1000)
  }

  const startPreview = async () => {
    const dir = directory()
    if (!dir) return
    setState({ type: "loading" })
    setIframeReady(false)
    setPhaseMessage("")
    startPhasePolling(dir)

    // A failed dev server only falls back to the raw index.html when the server
    // says that fallback is meaningful (static sites). Framework projects would
    // otherwise show a blank SPA shell instead of the real start error.
    const fail = (message: string, fallback: unknown) => {
      if (fallback) return tryStaticPreview()
      setState({ type: "error", message })
    }

    try {
      const result = await serverSDK().client.global.preview.start({ directory: dir })
      const data = result.data as any
      if (data?.success && data?.url) {
        const url = normalizePreviewUrl(data.url)
        if (centralRuntime.get().mode === "central" && new URL(url, location.href).origin === location.origin)
          throw new Error("Preview isolation is misconfigured.")
        setPreviewUrl(dir, url)
        setState({ type: "live", url })
        return
      }
      const body = data ?? (result as any).error
      if (body && typeof body.error === "string") {
        await fail(body.error, body.fallback)
        return
      }
      await tryStaticPreview()
    } catch (err) {
      // The SDK throws on 400 because it is configured with throwOnError; the
      // server's start-failure body survives on `cause.body`.
      const body = (err as { cause?: { body?: unknown } } | undefined)?.cause?.body
      const failure = body && typeof body === "object" ? (body as { error?: unknown; fallback?: unknown }) : undefined
      if (failure && typeof failure.error === "string") {
        await fail(failure.error, failure.fallback)
        return
      }
      await tryStaticPreview()
    } finally {
      stopPhasePolling()
    }
  }

  const tryStaticPreview = async () => {
    try {
      await file.load("index.html", { force: true })
    } catch {
      setState({
        type: "error",
        message: "The dev server failed to start and this project has no index.html to fall back to.",
      })
      return
    }
    const html = await loadPreviewHtml(file)
    if (!html) {
      setState({ type: "error", message: "The dev server failed to start and index.html could not be read." })
      return
    }
    if (centralRuntime.get().mode === "central") {
      try {
        const response = await fetch(`${serverSDK().url}/global/preview/static`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directory: directory(), html }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`The static preview could not be created (HTTP ${response.status}).`)
        const result: unknown = await response.json()
        if (!result || typeof result !== "object" || !("url" in result) || typeof result.url !== "string")
          throw new Error("The static preview returned an invalid address.")
        if (new URL(result.url, location.href).origin === location.origin)
          throw new Error("The preview must use a separate origin.")
        setState({ type: "live", url: result.url })
      } catch (error) {
        setState({ type: "error", message: error instanceof Error ? error.message : "Failed to load preview." })
      }
      return
    }
    setState({ type: "static", html })
  }

  const reloadPreview = () => {
    const dir = directory()
    if (!dir) return
    setState({ type: "idle" })
    setIframeReady(false)
    started = false
    startPreview()
  }

  const silentReload = () => {
    const current = state()
    if (current.type === "live") {
      setLiveReloadKey((k) => k + 1)
    }
  }

  const handlePreviewReady = () => {
    setIframeReady(true)
  }

  createEffect(() => {
    props.onPreviewReady?.(iframeReady())
  })

  let started = false

  createEffect(
    on(directory, (dir) => {
      if (!dir || started) return
      started = true
      startPreview()
    }),
  )

  createEffect(
    on(
      () => props.nonce,
      (next, prev) => {
        if (prev === undefined) return
        reloadPreview()
      },
    ),
  )

  createEffect(
    on(
      () => props.reloadKey,
      (_next, prev) => {
        if (prev === undefined) return
        silentReload()
      },
    ),
  )

  return (
    <>
      <div class="w-full h-full overflow-hidden relative">
        <Show when={props.questionRequest} keyed>
          {(request) => (
            <PreviewQuestionPanel
              request={request}
              agentName={props.agentName}
              onDone={() => props.onQuestionDone?.()}
            />
          )}
        </Show>
        <Show when={!props.questionRequest}>
          <Show
            when={state().type !== "idle"}
            fallback={
              <div class="w-full h-full flex items-center justify-center bg-background-base">
                <BrandLogo size="extra-large" />
              </div>
            }
          >
            <Show when={state().type === "loading"}>
              <div class="w-full h-full flex items-center justify-center bg-background-base">
                <div class="flex flex-col items-center gap-3">
                  <BrandLogo size="large" class="opacity-30 animate-pulse" />
                  <div class="text-12-regular text-text-weak">
                    {phaseMessage() || language.t("preview.starting")}
                  </div>
                </div>
              </div>
            </Show>
            <div
              ref={initContainerRef}
              class="w-full h-full relative flex justify-center"
              style={{
                width: frozenWidth() !== null ? `${frozenWidth()}px` : undefined,
                overflow: "clip",
                transition: props.isResizing ? undefined : "width 150ms ease-out",
                "pointer-events": props.isResizing ? "none" : undefined,
              }}
            >
              <PreviewZoomOverlay active={ctrlHeld} />
              <div
                class="flex h-full"
                style={{
                  width: props.deviceWidth ? `${props.deviceWidth}px` : "100%",
                  zoom:
                    props.deviceWidth === 768 || props.deviceWidth === 360
                      ? undefined
                      : fitScale() != null
                        ? `${fitScale()! * (props.zoom ?? 1)}`
                        : undefined,
                  margin: props.deviceWidth === 768 || props.deviceWidth === 360 ? "0 auto" : undefined,
                }}
              >
                <Show when={state().type === "live"}>
                  <LivePreview
                    url={liveUrl() ?? ""}
                    reloadKey={liveReloadKey()}
                    onReady={handlePreviewReady}
                    nav={externalNav}
                    onIframeLoaded={() => setIframeLoaded((n) => n + 1)}
                    onUrlChange={(url) => {
                      setPreviewUrl(directory(), url)
                      props.onUrlChange?.(url)
                    }}
                  />
                </Show>
                <Show when={staticHtml()}>
                  <StaticPreview html={staticHtml()!} nonce={props.nonce} onReady={handlePreviewReady} />
                </Show>
              </div>
            </div>
            <Show when={showError()}>
              <div class="w-full h-full flex flex-col items-center justify-center gap-3 bg-background-base absolute inset-0 z-20 px-6">
                <BrandLogo size="large" />
                <Show when={errorMessage()}>
                  <div class="text-12-regular text-text-weak text-center max-w-[480px] max-h-40 overflow-auto whitespace-pre-wrap break-words">
                    {errorMessage()}
                  </div>
                </Show>
                <button
                  type="button"
                  class="flex items-center gap-1.5 h-8 px-3 rounded-md text-12-medium text-text-strong border border-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={reloadPreview}
                >
                  <Icon name="refresh" size="small" />
                  {language.t("preview.action.reloadPreview")}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </>
  )
}
