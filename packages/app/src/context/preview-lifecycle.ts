import { centralRuntime } from "@/utils/central-state"
import { previewUrl } from "@/utils/preview-url"
import { onCleanup, onMount } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { useServerSync } from "./server-sync"
import { createMemo } from "solid-js"

const activeSessions = new Map<string, number>()
const previewUrls = new Map<string, string>()
// The server reclaims an unused preview dev server after IDLE_TTL_MS (180s, and
// proxied/HMR traffic also counts as activity). Background tabs clamp timers to
// ~60s, so keep this at one minute: worst case a throttled tick lands at ~120s,
// still short of the 180s eviction deadline.
// This heartbeat is also what keeps an open project's MicroVM from being
// suspended as idle, so it must arrive well inside the control plane's idle
// window (OPENCODE_WORKSPACE_IDLE_MS); at 60s it raced a 60s window and the VM
// was paused under an open tab.
const HEARTBEAT_INTERVAL_MS = 30_000

export function normalizePreviewUrl(url: string): string {
  return previewUrl(url, window.location.origin, centralRuntime.get().mode === "central")
}

export function getPreviewUrl(directory: string): string | undefined {
  return previewUrls.get(directory)
}

export function setPreviewUrl(directory: string, url: string): void {
  previewUrls.set(directory, url)
}

export function usePreviewLifecycle(directory: () => string) {
  const serverSDK = useServerSDK()

  const stopServer = async (dir: string) => {
    if (!dir) return
    const refs = (activeSessions.get(dir) ?? 1) - 1
    activeSessions.set(dir, refs)
    if (refs > 0) return
    activeSessions.delete(dir)
    previewUrls.delete(dir)
    try {
      await serverSDK().createClient({ directory: dir, throwOnError: true }).global.preview.stop({ body_directory: dir })
    } catch {}
  }

  const startServer = async (dir: string) => {
    if (!dir) return
    const refs = (activeSessions.get(dir) ?? 0) + 1
    activeSessions.set(dir, refs)
    if (refs > 1) return
    try {
      const result = await serverSDK().createClient({ directory: dir, throwOnError: true }).global.preview.start({ body_directory: dir })
      const data = result.data as any
      if (data?.success && data?.url) {
        previewUrls.set(dir, normalizePreviewUrl(data.url))
      }
    } catch {}
  }

  onMount(() => {
    startServer(directory())
    const dir = directory()
    if (!dir) return
    const heartbeat = setInterval(() => {
      serverSDK()
        .createClient({ directory: dir, throwOnError: true })
        .global.preview.heartbeat({ body_directory: dir })
        .catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    onCleanup(() => clearInterval(heartbeat))
  })

  onCleanup(() => {
    stopServer(directory())
  })

  if (typeof window !== "undefined") {
    const dir = directory()
    const handler = () => {
      if (dir) stopServer(dir)
    }
    window.addEventListener("pagehide", handler)
    window.addEventListener("beforeunload", handler)
    onCleanup(() => {
      window.removeEventListener("pagehide", handler)
      window.removeEventListener("beforeunload", handler)
    })
  }

  return {
    start: () => startServer(directory()),
    stop: () => stopServer(directory()),
  }
}
