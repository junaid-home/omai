import { toPng } from "html-to-image"
import { base64Encode } from "@opencode-ai/core/util/encode"

function findCaptureTarget(): HTMLElement | null {
  const iframe = document.querySelector<HTMLIFrameElement>("#review-panel iframe[title='Preview']")
  if (iframe && iframe.contentDocument?.body && iframe.contentDocument.body.clientHeight > 0) {
    return iframe.contentDocument.body
  }
  const preview = document.querySelector<HTMLElement>("#review-panel [data-slot='session-review-v2-preview']")
  if (preview && preview.clientHeight > 0) return preview
  if (iframe && iframe.parentElement && iframe.parentElement.clientHeight > 0) return iframe.parentElement
  return null
}

function waitForIframeLoad(target: HTMLElement): Promise<void> {
  const iframe = document.querySelector<HTMLIFrameElement>("#review-panel iframe[title='Preview']")
  if (!iframe) return Promise.resolve()
  if (iframe.contentDocument?.readyState === "complete") {
    return new Promise((r) => setTimeout(r, 5000))
  }
  return new Promise((resolve) => {
    const onLoad = () => {
      iframe.removeEventListener("load", onLoad)
      setTimeout(resolve, 5000)
    }
    iframe.addEventListener("load", onLoad)
    setTimeout(resolve, 12000)
  })
}

let inflight: Promise<boolean> | null = null

export async function captureAndSaveThumbnail(directory: string, serverUrl: string): Promise<boolean> {
  if (inflight) return inflight
  inflight = doCapture(directory, serverUrl)
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

async function doCapture(directory: string, serverUrl: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const target = findCaptureTarget()
    if (target) {
      await waitForIframeLoad(target)
      return save(target, directory, serverUrl)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function save(target: HTMLElement, directory: string, serverUrl: string): Promise<boolean> {
  try {
    const dataUrl = await toPng(target, {
      cacheBust: true,
      pixelRatio: 1,
      backgroundColor: "#0f172a",
      skipAutoScale: true,
      includeQueryParams: true,
      height: 600,
      style: {
        position: "relative",
        width: "1200px",
        height: "600px",
        overflow: "hidden",
      },
    })

    const base64 = dataUrl.split(",")[1]
    if (!base64 || base64.length < 100) return false

    const encodedDir = base64Encode(directory)
    const response = await fetch(`${serverUrl}/preview/thumbnail/${encodedDir}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: base64 }),
    })

    return response.ok
  } catch {
    return false
  }
}
