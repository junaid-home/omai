import { createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { toaster } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { importBrowserState, type matchingBrowserState } from "@/utils/central-import"
import { centralRuntime, type StateSnapshot } from "@/utils/central-state"

/** Storage lifecycle only. Normal loading and saving add no controls or overlay to the original UI. */
export function CentralStateStatus(props: { browserImport?: ReturnType<typeof matchingBrowserState> }) {
  const client = centralRuntime.get().client
  if (!client) return null
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ entries: client.snapshots() })
  const notices = new Map<string, { id: number; signature: string }>()
  const keyOf = (entry: StateSnapshot) => JSON.stringify([entry.namespace, entry.key])
  const failed = (error: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : "Please try again.",
      variant: "error",
    })
  const perform = (task: Promise<unknown>) => {
    void task.catch(failed)
  }
  const label = (entry: StateSnapshot) =>
    ({
      drafts: "Draft",
      comments: "Comments",
      preferences: "Preferences",
      history: "History",
      notifications: "Notifications",
      permissions: "Permission preferences",
      workspace: "Workspace state",
      ui: "View settings",
    })[entry.namespace]
  const compare = (address: StateSnapshot) => {
    const current = () => state.entries.find((entry) => keyOf(entry) === keyOf(address))
    void dialog.show(
      () => (
        <Dialog title={label(address) + ": Changed in another browser"}>
          <div class="flex flex-col gap-4 p-6">
            <TextField label="This tab" value={current()?.value ?? "Deleted"} readOnly multiline />
            <TextField label="Saved on the server" value={current()?.remote?.value ?? "Deleted"} readOnly multiline />
            <div class="flex justify-end gap-2">
              <Button
                disabled={current()?.status !== "conflict"}
                onClick={() => perform(client.resolve(address, "remote").then(dialog.close))}
              >
                Use server version
              </Button>
              <Button
                variant="primary"
                disabled={current()?.status !== "conflict"}
                onClick={() => perform(client.resolve(address, "local").then(dialog.close))}
              >
                Save this tab’s version
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {
        // Closing a comparison does not resolve it; keep its recovery action available.
        notices.delete(keyOf(address))
        update()
      },
    )
  }
  const update = () => setState("entries", client.snapshots())
  onCleanup(client.subscribe(update))
  createEffect(() => {
    const errors = state.entries.filter((entry) => entry.status === "error" || entry.status === "conflict")
    const active = new Set(errors.map(keyOf))
    notices.forEach((notice, key) => {
      if (active.has(key)) return
      toaster.dismiss(notice.id)
      notices.delete(key)
    })
    errors.forEach((entry) => {
      const key = keyOf(entry)
      const signature = JSON.stringify([entry.status, entry.error, entry.revision, entry.remote?.revision, entry.value])
      const previous = notices.get(key)
      if (previous?.signature === signature) return
      if (previous) toaster.dismiss(previous.id)
      const id = showToast({
        title: label(entry) + ": " + (entry.status === "conflict" ? "Changed in another browser" : "Not saved"),
        description: (entry.error ?? "") + " Your current changes remain in this tab.",
        variant: "error",
        persistent: true,
        actions: [
          {
            label: entry.status === "conflict" ? "Compare versions" : "Retry saving",
            onClick: () => (entry.status === "conflict" ? compare(entry) : perform(client.retry(entry))),
          },
        ],
      })
      notices.set(key, { id, signature })
    })
  })
  const unload = (event: BeforeUnloadEvent) => {
    if (!client.dirty()) return
    event.preventDefault()
    event.returnValue = ""
    perform(client.flush())
  }
  const refresh = () => {
    if (document.visibilityState === "visible") void client.refresh().catch(() => undefined)
  }
  const online = () => {
    client
      .snapshots()
      .filter((entry) => entry.status === "error")
      .forEach((entry) => perform(client.retry(entry)))
    refresh()
  }
  window.addEventListener("beforeunload", unload)
  window.addEventListener("online", online)
  document.addEventListener("visibilitychange", refresh)
  const timer = setInterval(refresh, 30_000)
  onCleanup(() => {
    clearInterval(timer)
    window.removeEventListener("beforeunload", unload)
    window.removeEventListener("online", online)
    document.removeEventListener("visibilitychange", refresh)
    notices.forEach((notice) => toaster.dismiss(notice.id))
  })
  onMount(() => {
    const source = props.browserImport
    const user = centralRuntime.get().user
    if (!source || !user) return
    const id = showToast({
      title: "Previous browser data",
      description: "Browser data associated with " + user.username + " is available to review.",
      actions: [
        {
          label: "Review",
          onClick: () => {
            void dialog.show(() => (
              <Dialog
                title="Import browser data"
                description={
                  "Only continue if these drafts and preferences belong to " +
                  user.username +
                  ". Existing server data is preserved."
                }
              >
                <div class="flex justify-end gap-2 p-6">
                  <Button onClick={dialog.close}>{language.t("common.cancel")}</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      dialog.close()
                      perform(
                        importBrowserState(client, source).then((result) => {
                          showToast({
                            description:
                              result.imported +
                              " imported, " +
                              result.existing +
                              " already saved on the server, " +
                              result.failed +
                              " could not be imported.",
                          })
                        }),
                      )
                    }}
                  >
                    Import browser data
                  </Button>
                </div>
              </Dialog>
            ))
          },
        },
      ],
    })
    onCleanup(() => toaster.dismiss(id))
  })
  return null
}
