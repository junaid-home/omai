import { onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { toaster } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { importBrowserState, type matchingBrowserState } from "@/utils/central-import"
import { centralRuntime } from "@/utils/central-state"

/** Storage lifecycle only. Normal loading and saving add no controls or overlay to the original UI. */
export function CentralStateStatus(props: { browserImport?: ReturnType<typeof matchingBrowserState> }) {
  const client = centralRuntime.get().client
  if (!client) return null
  const dialog = useDialog()
  const language = useLanguage()
  const perform = (task: Promise<unknown>) => {
    void task.catch(() => undefined)
  }
  // Conflicts and failed saves recover silently so simultaneous use never interrupts the user.
  const heal = () => {
    for (const entry of client.snapshots()) {
      if (entry.status === "conflict") void client.resolve(entry, "local").catch(() => undefined)
      if (entry.status === "error") void client.retry(entry).catch(() => undefined)
    }
  }
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
    heal()
    refresh()
  }
  window.addEventListener("beforeunload", unload)
  window.addEventListener("online", online)
  document.addEventListener("visibilitychange", refresh)
  const healTimer = setInterval(heal, 5_000)
  const refreshTimer = setInterval(refresh, 30_000)
  onCleanup(() => {
    clearInterval(healTimer)
    clearInterval(refreshTimer)
    window.removeEventListener("beforeunload", unload)
    window.removeEventListener("online", online)
    document.removeEventListener("visibilitychange", refresh)
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
