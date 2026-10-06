import { createEffect, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import type { CheckpointListResponse } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useQuery, useQueryClient, useMutation } from "@tanstack/solid-query"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSessionLayout } from "@/pages/session/session-layout"
import "./session-checkpoints-tab.css"

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

function formatAbsolute(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatRelative(timestamp: number): string {
  const diff = timestamp - Math.floor(Date.now() / 1000)
  for (const [unit, seconds] of relativeUnits) {
    const value = Math.round(diff / seconds)
    if (Math.abs(value) >= 1 && isFinite(value)) {
      try {
        return relativeTime.format(value, unit)
      } catch {
        // ignore
      }
    }
  }
  try {
    return relativeTime.format(diff, "second")
  } catch {
    return formatAbsolute(timestamp)
  }
}

export interface SessionCheckpointsTabProps {
  onSelectCheckpoint?: (checkpointID: string) => void
  onSetCheckpointID?: (checkpointID: string) => void
}

export function SessionCheckpointsTab(props: SessionCheckpointsTabProps = {}) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const queryClient = useQueryClient()
  const { view, tabs } = useSessionLayout() as any

  const [state, setState] = createStore({
    confirming: undefined as CheckpointSummary | undefined,
    pending: false,
  })

  const projectID = () => sync().project?.id
  const checkpointKey = () => [sdk().scope, sdk().directory, "checkpoints", projectID() ?? ""] as const

  const checkpointQuery = useQuery(() => ({
    queryKey: checkpointKey(),
    enabled: !!projectID() && sync().project?.vcs === "git",
    queryFn: async () => {
      if (!projectID()) return []
      const result = await sdk().client.checkpoint.list({ projectID: projectID()!, directory: sdk().directory })
      return result.data ?? []
    },
  }))

  const rollbackMutation = useMutation(() => ({
    mutationFn: async ({ checkpointID }: { checkpointID: string }) => {
      if (!projectID()) return
      await sdk().client.checkpoint.rollback({ projectID: projectID()!, checkpointID, directory: sdk().directory })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: checkpointKey() })
      showToast({ variant: "success", title: language.t("session.checkpoint.restored") })
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    },
  }))

  const rollback = async () => {
    const item = state.confirming
    if (!item || state.pending) return
    setState("pending", true)
    try {
      await rollbackMutation.mutateAsync({ checkpointID: item.id })
      setState("confirming", undefined)
    } finally {
      setState("pending", false)
    }
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    if (state.confirming) setState("confirming", undefined)
  }

  onMount(() => window.addEventListener("keydown", onKeydown))
  onCleanup(() => window.removeEventListener("keydown", onKeydown))

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

  const checkpoints = () => checkpointQuery.data ?? []

  return (
    <div class="session-tools-tab-panel h-full flex flex-col">
      <div class="session-tools-tab-header">
        <div class="text-16-medium text-v2-text-text-base">{language.t("session.checkpoint.title")}</div>
        <div class="text-13-regular text-v2-text-text-muted">{language.t("session.checkpoint.description")}</div>
      </div>
      <ScrollView class="flex-1 min-h-0 overflow-hidden px-3">
        <div class="flex flex-col gap-2 pb-14">
          <Show
            when={!checkpointQuery.isLoading && checkpoints().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
                <div class="flex size-10 items-center justify-center rounded-2xl border border-v2-border-border-base bg-v2-background-bg-layer-01 text-text-weak">
                  <IconV2 name="history" />
                </div>
                <div class="text-14-medium text-v2-text-text-base">{language.t("session.checkpoint.empty")}</div>
                <div class="max-w-72 text-12-regular text-v2-text-text-muted">
                  {language.t("session.checkpoint.description")}
                </div>
              </div>
            }
          >
            <For each={checkpoints()}>
              {(item, index) => {
                const created = item.time.created
                const absolute = formatAbsolute(typeof created === "number" ? created : Number(created))
                const relative = formatRelative(
                  typeof item.time.created === "number" ? item.time.created : Number(item.time.created),
                )
                const firstFile = item.files[0]?.split("/").pop()
                const active = index() === 0
                return (
                  <div class="group flex gap-3 pb-4 last:pb-0">
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
                      <Show when={index() < checkpoints().length - 1}>
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
                      class="flex min-w-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200 flex-col overflow-hidden rounded-xl border transition-[background-color,border-color]"
                      style={{ "animation-delay": `${Math.min(index(), 8) * 30}ms` }}
                      classList={{
                        "border-v2-background-bg-accent bg-v2-background-bg-layer-01": active,
                        "border-v2-border-border-base bg-v2-background-bg-base": !active,
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
                      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-v2-border-border-base px-3 py-2">
                        <ButtonV2
                          size="small"
                          variant="neutral"
                          onClick={() => {
                            props.onSelectCheckpoint?.(item.id)
                          }}
                        >
                          {language.t("session.checkpoint.viewChanges")}
                        </ButtonV2>
                        <ButtonV2
                          size="small"
                          variant="neutral"
                          onClick={() => setState("confirming", item)}
                          disabled={state.pending && state.confirming?.id === item.id}
                        >
                          {language.t("session.checkpoint.rollback")}
                        </ButtonV2>
                      </div>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </ScrollView>

      <Show when={state.confirming}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div class="w-full max-w-md overflow-hidden rounded-xl border border-v2-border-border-base bg-v2-background-bg-base shadow-lg">
            <div class="flex flex-col gap-2 border-b border-v2-border-border-base p-4">
              <div class="text-16-medium text-v2-text-text-base">{language.t("session.checkpoint.rollback.title")}</div>
              <div class="text-12-regular text-v2-text-text-muted">
                {language.t("session.checkpoint.rollback.impact")}
              </div>
            </div>
            <div class="flex flex-col gap-3 p-4">
              <For each={impact}>
                {(item) => (
                  <div class="flex flex-col gap-1 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
                    <div class="text-13-medium text-v2-text-text-base">{item.title}</div>
                    <div class="text-12-regular text-v2-text-text-muted">{item.description}</div>
                  </div>
                )}
              </For>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2 border-t border-v2-border-border-base p-4">
              <ButtonV2 variant="ghost" onClick={() => setState("confirming", undefined)} disabled={state.pending}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="danger" onClick={rollback} disabled={state.pending} loading={state.pending}>
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
