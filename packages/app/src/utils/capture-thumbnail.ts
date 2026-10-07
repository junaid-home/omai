import { base64Encode } from "@opencode-ai/core/util/encode"

let inflight: Promise<boolean> | null = null

/**
 * The server renders the preview with headless Chromium at a fixed 1200x600
 * viewport, so the thumbnail no longer depends on the caller's screen size or
 * on the preview iframe having painted before the request.
 */
export async function captureAndSaveThumbnail(directory: string, serverUrl: string): Promise<boolean> {
  if (inflight) return inflight
  inflight = request(directory, serverUrl)
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

async function request(directory: string, serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/preview/thumbnail/${base64Encode(directory)}/capture`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    })
    return response.ok
  } catch {
    // A failed capture keeps the previous thumbnail in place.
    return false
  }
}
