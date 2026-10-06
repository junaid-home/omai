import { Show, For, createResource, createMemo, createSignal, ErrorBoundary, Suspense, Match, Switch } from "solid-js"
import { useParams } from "@solidjs/router"
import { SessionTurn } from "@opencode-ai/session-ui/session-turn"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { FileSSR } from "@opencode-ai/session-ui/file-ssr"
import { MessageNav } from "@opencode-ai/session-ui/message-nav"
import { DateTime } from "luxon"
import { createStore } from "solid-js/store"
import type { Message, Part, Session, Model, SnapshotFileDiff, UserMessage } from "@opencode-ai/sdk/v2"

type ShareDataItem =
  | { type: "session"; data: Session }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: SnapshotFileDiff[] }
  | { type: "model"; data: Model[] }

type NormalizedData = {
  sessionID: string
  shareID: string
  session: Session[]
  session_diff: { [sessionID: string]: SnapshotFileDiff[] }
  session_status: { [sessionID: string]: { type: "idle" } }
  message: { [sessionID: string]: Message[] }
  part: { [messageID: string]: Part[] }
  model: { [sessionID: string]: Model[] }
}

function normalizeData(shareID: string, items: ShareDataItem[]): NormalizedData | null {
  if (!items.length) return null

  const sessionItem = items.find((i) => i.type === "session")
  if (!sessionItem || sessionItem.type !== "session") return null

  const sessionID = sessionItem.data.id
  const result: NormalizedData = {
    sessionID,
    shareID,
    session: [sessionItem.data],
    session_diff: { [sessionID]: [] },
    session_status: { [sessionID]: { type: "idle" } },
    message: {},
    part: {},
    model: {},
  }

  for (const item of items) {
    switch (item.type) {
      case "session":
        result.session.push(item.data)
        break
      case "session_diff":
        result.session_diff[sessionID] = item.data
        break
      case "message":
        result.message[item.data.sessionID] = result.message[item.data.sessionID] ?? []
        result.message[item.data.sessionID].push(item.data)
        break
      case "part":
        result.part[item.data.messageID] = result.part[item.data.messageID] ?? []
        result.part[item.data.messageID].push(item.data)
        break
      case "model":
        result.model[sessionID] = item.data
        break
    }
  }

  return result
}

async function fetchShareData(shareID: string): Promise<NormalizedData> {
  const shareBase = "https://opncd.ai"
  const response = await fetch(`${shareBase}/api/share/${shareID}/data`)
  if (!response.ok) {
    throw new Error(`Failed to fetch share data: ${response.status}`)
  }
  const items: ShareDataItem[] = await response.json()
  const normalized = normalizeData(shareID, items)
  if (!normalized) {
    throw new Error("Invalid share data")
  }
  return normalized
}

export default function SharePage() {
  const params = useParams()

  const [data] = createResource(() => params.id, fetchShareData)

  return (
    <ErrorBoundary
      fallback={(error) => {
        console.error(error)
        const details = error instanceof Error ? (error.stack ?? error.message) : String(error)
        return (
          <div class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-4 p-6 text-center">
            <p class="text-16-medium">Unable to load this share.</p>
            <p class="text-14-regular text-text-weaker">{details}</p>
          </div>
        )
      }}
    >
      <Suspense
        fallback={
          <div class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center">
            <p class="text-14-regular text-text-weaker">Loading shared session...</p>
          </div>
        }
      >
        <Show when={data()}>
          {(resolvedData) => {
            const [store, setStore] = createStore({
              messageId: undefined as string | undefined,
            })

            const messages = createMemo(() => {
              const d = resolvedData()
              return (d.message[d.sessionID] ?? [])
                .filter((m) => m.role === "user")
                .sort((a, b) => a.time.created - b.time.created)
            })

            const firstUserMessage = createMemo(() => messages().at(0))

            const activeMessage = createMemo(
              () => messages().find((m) => m.id === store.messageId) ?? firstUserMessage(),
            )

            function setActiveMessage(message: UserMessage | undefined) {
              if (message) {
                setStore("messageId", message.id)
              } else {
                setStore("messageId", undefined)
              }
            }

            const provider = createMemo(() => {
              const d = resolvedData()
              const msgs = d.message[d.sessionID] ?? []
              const assistantMsg = msgs.find((m) => m.role === "assistant" && m.modelID)
              return assistantMsg && assistantMsg.role === "assistant" ? assistantMsg.providerID : undefined
            })

            const modelID = createMemo(() => {
              const d = resolvedData()
              const msgs = d.message[d.sessionID] ?? []
              const assistantMsg = msgs.find((m) => m.role === "assistant" && m.modelID)
              return assistantMsg && assistantMsg.role === "assistant" ? assistantMsg.modelID : undefined
            })

            const model = createMemo(() => {
              const d = resolvedData()
              const id = modelID()
              if (!id) return undefined
              return d.model[d.sessionID]?.find((m) => m.id === id)
            })

            const title = () => (
              <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-2 sm:flex-row sm:gap-4 sm:items-center sm:h-8 justify-start self-stretch">
                  <div class="flex gap-4 items-center">
                    <div class="flex gap-2 items-center">
                      <Show when={provider()}>
                        <ProviderIcon id={provider()!} class="size-3.5 shrink-0 text-icon-strong-base" />
                      </Show>
                      <div class="text-12-regular text-text-base">{model()?.name ?? modelID() ?? ""}</div>
                    </div>
                    <div class="text-12-regular text-text-weaker">
                      {DateTime.fromMillis(
                        resolvedData().session.find((s) => s.id === resolvedData().sessionID)!.time.created,
                      ).toFormat("dd MMM yyyy, HH:mm")}
                    </div>
                  </div>
                </div>
                <div class="text-left text-16-medium text-text-strong">
                  {resolvedData().session.find((s) => s.id === resolvedData().sessionID)!.title}
                </div>
              </div>
            )

            return (
              <FileComponentProvider component={FileSSR}>
                <DataProvider
                  data={resolvedData()}
                  directory={resolvedData().session.find((s) => s.id === resolvedData().sessionID)!.directory}
                >
                  <div class="relative bg-background-stronger w-screen h-screen overflow-hidden flex flex-col">
                    <header class="h-12 px-6 py-2 flex items-center justify-between self-stretch bg-background-base border-b border-border-weak-base shrink-0" />
                    <div class="select-text flex flex-col flex-1 min-h-0">
                      <div class="hidden md:flex w-full flex-1 min-h-0">
                        <div class="@container relative shrink-0 pt-14 flex flex-col gap-10 min-h-0 w-full">
                          <div class="w-full flex justify-start items-start min-w-0 px-6">{title()}</div>
                          <div class="flex items-start justify-start h-full min-h-0">
                            <Show when={messages().length > 1}>
                              <MessageNav
                                class="sticky top-0 shrink-0 py-2 pl-4"
                                messages={messages()}
                                current={activeMessage()}
                                size="compact"
                                onMessageSelect={setActiveMessage}
                                getLabel={(message) =>
                                  resolvedData()
                                    .part[message.id]?.find((part) => part.type === "text")
                                    ?.text.trim()
                                    .split("\n")[0]
                                }
                              />
                            </Show>
                            <SessionTurn
                              sessionID={resolvedData().sessionID}
                              messageID={store.messageId ?? firstUserMessage()!.id!}
                              classes={{
                                root: "grow",
                                content: "flex flex-col justify-between",
                                container: "w-full pb-20 px-6",
                              }}
                            />
                          </div>
                        </div>
                      </div>
                      <div class="!overflow-hidden md:hidden">
                        <div class="relative mt-2 pb-8 min-w-0 w-full h-full overflow-y-auto no-scrollbar">
                          <div class="px-4 py-6">{title()}</div>
                          <div class="flex flex-col gap-15 items-start justify-start mt-4">
                            <For each={messages()}>
                              {(message) => (
                                <SessionTurn
                                  sessionID={resolvedData().sessionID}
                                  messageID={message.id}
                                  classes={{
                                    root: "min-w-0 w-full relative",
                                    content: "flex flex-col justify-between !overflow-visible",
                                    container: "px-4",
                                  }}
                                />
                              )}
                            </For>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </DataProvider>
              </FileComponentProvider>
            )
          }}
        </Show>
      </Suspense>
    </ErrorBoundary>
  )
}
