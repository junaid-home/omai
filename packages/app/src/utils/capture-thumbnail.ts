import { base64Encode } from "@opencode-ai/core/util/encode"

export type CaptureResult = "written" | "skipped" | "failed"

let queue: Promise<unknown> = Promise.resolve()

/**
 * The server renders the preview with headless Chromium at a fixed 1200x600
 * viewport, so the thumbnail no longer depends on the caller's screen size or
 * on the preview iframe having painted before the request.
 *
 * Requests run one at a time so a burst of triggers (e.g. every project card
 * on the list) never spawns Chromium in parallel.
 */
export function captureAndSaveThumbnail(directory: string, serverUrl: string): Promise<CaptureResult> {
  const task = queue.then(
    () => request(directory, serverUrl),
    () => request(directory, serverUrl),
  )
  queue = task
  return task
}

async function request(directory: string, serverUrl: string): Promise<CaptureResult> {
  try {
    const response = await fetch(`${serverUrl}/preview/thumbnail/${base64Encode(directory)}/capture`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    })
    if (!response.ok) return "failed"
    const body = await response.json().catch(() => ({} as Record<string, unknown>))
    // The server skips work when the thumbnail is fresh, the snapshot is unchanged, or it is cooling down after a failure.
    return body.skipped ? "skipped" : "written"
  } catch {
    // A failed capture keeps the previous thumbnail in place.
    return "failed"
  }
}
