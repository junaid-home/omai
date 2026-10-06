import type { CheckpointListResponse } from "@opencode-ai/sdk/v2"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"

export type CheckpointSummary = CheckpointListResponse[number]

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_557_600],
  ["month", 2_629_800],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
]

export function CheckpointHistoryView(props: {
  checkpoints: ReadonlyArray<CheckpointSummary>
  selectedID?: string
  onSelect: (id: string) => void
  onRollback: (id: string) => Promise<void>
  onClose: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    confirming: undefined as CheckpointSummary | undefined,
    pending: false,
  })
  let root: HTMLDivElement | undefined

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    if (state.confirming) setState("confirming", undefined)
    else props.onClose()
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown)
    root?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "center" })
  })
  onCleanup(() => window.removeEventListener("keydown", onKeydown))

  const rollback = async () => {
    const item = state.confirming
    if (!item || state.pending) return
    setState("pending", true)
    try {
      await props.onRollback(item.id)
      props.onClose()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("pending", false)
    }
  }

  const impact = [
    {
      title: language.t("session.checkpoint.rollback.files.title"),
      description: language.t("session.checkpoint.rollback.files.description"),
    },
    {
      title: language.t("session.checkpoint.rollback.database.title"),
      description: language.t("session.checkpoint.rollback.database.description"),
    },
    {
      title: language.t("session.checkpoint.rollback.memory.title"),
      description: language.t("session.checkpoint.rollback.memory.description"),
    },
  ]

  return (
    <div
      ref={(el) => (root = el)}
      role="region"
      aria-label={language.t("session.checkpoint.title")}
      class="relative flex h-full min-h-0 flex-col animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      <div class="flex shrink-0 items-start gap-4 border-b border-v2-border-border-base px-6 py-5">
        <div class="flex min-w-0 flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-16-medium text-text-strong">{language.t("session.checkpoint.title")}</span>
            <span class="rounded-full border border-v2-border-border-base px-1.5 py-px text-11-medium text-text-weak tabular-nums">
              {props.checkpoints.length}
            </span>
          </div>
          <span class="text-12-regular text-text-weak">{language.t("session.checkpoint.description")}</span>
        </div>
        <div class="ml-auto shrink-0">
          <IconButtonV2
            variant="ghost-muted"
            size="normal"
            aria-label={language.t("common.close")}
            onClick={props.onClose}
            icon={<IconV2 name="xmark-small" />}
          />
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5" style={{ "scrollbar-width": "thin" }}>
        <Show
          when={props.checkpoints.length > 0}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-3 text-center animate-in fade-in duration-300">
              <div class="flex size-12 items-center justify-center rounded-2xl border border-v2-border-border-base bg-v2-background-bg-layer-01 text-text-weak">
                <IconV2 name="history" size="large" />
              </div>
              <div class="text-14-medium text-text-strong">{language.t("session.checkpoint.empty")}</div>
              <div class="max-w-72 text-12-regular text-text-weak">{language.t("session.checkpoint.description")}</div>
            </div>
          }
        >
          <ol class="flex flex-col">
            <For each={props.checkpoints}>
              {(item, index) => {
                const absolute = formatAbsolute(item.time.created)
                const relative = formatRelative(item.time.created) ?? absolute
                const active = item.id === props.selectedID || index() === 0
                const firstFile = item.files[0]?.split("/").pop()
                return (
                  <li class="group flex gap-3 pb-4 last:pb-0">
                    <div class="relative flex w-5 shrink-0 flex-col items-center">
                      <span
                        class="z-10 mt-4 size-2.5 shrink-0 rounded-full"
                        classList={{
                          "bg-v2-background-bg-accent": active,
                          "bg-v2-border-border-strong": !active,
                        }}
                        style={
                          active
                            ? {
                                "box-shadow":
                                  "0 0 0 4px color-mix(in srgb, var(--v2-background-bg-accent, #0a4a8a) 22%, transparent)",
                              }
                            : undefined
                        }
                      />
                      <Show when={index() < props.checkpoints.length - 1}>
                        <span
                          class="absolute top-[30px] -bottom-7 w-px bg-v2-border-border-base"
                          style={
                            index() === 0
                              ? {
                                  background:
                                    "linear-gradient(to bottom, var(--v2-background-bg-accent, #0a4a8a), var(--v2-border-border-base, rgba(127,127,127,0.35)))",
                                }
                              : undefined
                          }
                        />
                      </Show>
                    </div>
                    <div
                      data-selected={item.id === props.selectedID ? "true" : undefined}
                      class="flex min-w-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200 flex-col overflow-hidden rounded-xl border transition-[background-color,border-color]"
                      style={{ "animation-delay": `${Math.min(index(), 8) * 30}ms` }}
                      classList={{
                        "border-v2-background-bg-accent bg-v2-background-bg-layer-01": item.id === props.selectedID,
                        "border-v2-border-border-base bg-v2-background-bg-base": item.id !== props.selectedID,
                      }}
                    >
                      <div class="flex min-w-0 flex-1 flex-col gap-2 p-3">
                        <div class="flex min-w-0 flex-1 flex-col gap-2">
                          <span class="truncate text-13-medium text-text-strong">
                            {item.title ?? language.t("session.checkpoint.untitled")}
                          </span>
                          <div class="flex flex-wrap items-center gap-1.5">
                            <Show when={firstFile}>
                              {(name) => (
                                <span
                                  class="max-w-40 truncate rounded-md bg-v2-background-bg-layer-01 px-1.5 py-0.5 font-mono text-10 text-text-weak"
                                  title={item.files[0]}
                                >
                                  {name()}
                                </span>
                              )}
                            </Show>
                            <Show when={item.files.length > 1}>
                              <span class="text-11-regular text-text-weak">
                                {language.t("session.checkpoint.fileCount", { count: item.files.length })}
                              </span>
                            </Show>
                            <Show when={Number(item.additions) > 0}>
                              <span
                                class="rounded-md px-1.5 py-0.5 text-10-medium tabular-nums"
                                style={{ background: "rgba(22,163,74,0.12)", color: "#16a34a" }}
                              >
                                +{String(item.additions)}
                              </span>
                            </Show>
                            <Show when={Number(item.deletions) > 0}>
                              <span
                                class="rounded-md px-1.5 py-0.5 text-10-medium tabular-nums"
                                style={{ background: "rgba(220,38,38,0.12)", color: "#dc2626" }}
                              >
                                -{String(item.deletions)}
                              </span>
                            </Show>
                            <Show when={item.database}>
                              <span class="rounded-md bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-10-medium text-text-weak">
                                {language.t("session.checkpoint.databaseBadge")}
                              </span>
                            </Show>
                            <Show when={item.memory}>
                              <span class="rounded-md bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-10-medium text-text-weak">
                                {language.t("session.checkpoint.memoryBadge")}
                              </span>
                            </Show>
                            <span class="ml-auto pl-2 text-11-regular text-text-weak tabular-nums" title={absolute}>
                              {relative}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center justify-end gap-1 border-t border-v2-border-border-base px-2 py-1.5">
                        <ButtonV2 variant="ghost" size="small" icon="code" onClick={() => props.onSelect(item.id)}>
                          {language.t("session.review.change.other")}
                        </ButtonV2>
                        <ButtonV2
                          variant="ghost"
                          size="small"
                          icon="outline-reset"
                          disabled={state.pending}
                          onClick={() => setState("confirming", item)}
                        >
                          {language.t("session.checkpoint.rollback")}
                        </ButtonV2>
                      </div>
                    </div>
                  </li>
                )
              }}
            </For>
          </ol>
        </Show>
      </div>
      <Show when={state.confirming}>
        <div class="absolute inset-0 z-20 flex animate-in fade-in duration-150">
          <div
            class="absolute inset-0 bg-black/20 backdrop-blur-[2px]"
            onClick={() => setState("confirming", undefined)}
          />
          <div class="relative mt-auto flex max-h-full w-full flex-col overflow-hidden rounded-t-2xl border-t border-v2-border-border-base bg-v2-background-bg-base shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
            <div class="flex min-h-0 flex-col gap-3 overflow-y-auto p-5" style={{ "scrollbar-width": "thin" }}>
              <div class="flex flex-col gap-1">
                <div class="text-14-medium text-text-strong">{language.t("session.checkpoint.rollback.title")}</div>
                <div class="text-12-regular text-text-weak">{language.t("session.checkpoint.rollback.impact")}</div>
              </div>
              <div class="flex flex-col rounded-xl border border-v2-border-border-base">
                <For each={impact}>
                  {(row, index) => (
                    <div class="p-3" classList={{ "border-t border-v2-border-border-base": index() > 0 }}>
                      <div class="text-13-medium text-text-strong">{row.title}</div>
                      <div class="text-12-regular text-text-weak">{row.description}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div class="flex shrink-0 justify-end gap-2 border-t border-v2-border-border-base p-4">
              <ButtonV2 variant="ghost" onClick={() => setState("confirming", undefined)} disabled={state.pending}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="danger" onClick={rollback} disabled={state.pending}>
                {state.pending
                  ? language.t("session.checkpoint.rollback.pending")
                  : language.t("session.checkpoint.rollback.confirm")}
              </ButtonV2>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

function formatAbsolute(value: number | string) {
  const time = new Date(Number(value))
  if (Number.isNaN(time.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time)
}

function formatRelative(value: number | string) {
  const time = new Date(Number(value))
  if (Number.isNaN(time.getTime())) return undefined
  const delta = time.getTime() - Date.now()
  const seconds = Math.abs(delta) / 1000
  if (seconds < 60) return relativeTime.format(0, "second")
  const unit = relativeUnits.find(([, size]) => seconds >= size) ?? (["minute", 60] as const)
  return relativeTime.format(Math.trunc(delta / (unit[1] * 1000)), unit[0])
}
