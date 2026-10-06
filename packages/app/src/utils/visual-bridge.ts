import { batch, createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComputedStyles, ElementInfo, VisualChange } from "@/context/visual-editor"

const STYLE_KEYS = [
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontFamily",
  "color",
  "backgroundColor",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "textAlign",
  "lineHeight",
  "letterSpacing",
  "borderRadius",
  "border",
  "opacity",
] as const
const MAX_HTML = 8 * 1024 * 1024

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}
function text(input: unknown, max = 65_536): input is string {
  return typeof input === "string" && input.length <= max
}

export function visualElement(input: unknown, offset = { x: 0, y: 0, scaleX: 1, scaleY: 1 }): ElementInfo | null {
  if (
    !record(input) ||
    !text(input.tagName, 100) ||
    !text(input.textContent, 500) ||
    !text(input.outerHTML, 2000) ||
    !text(input.cssSelector, 2048) ||
    !record(input.bounds) ||
    !record(input.attributes) ||
    !record(input.computedStyles) ||
    typeof input.isImage !== "boolean"
  )
    return null
  const bounds = input.bounds
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000,
    )
  )
    return null
  const attributes = Object.entries(input.attributes)
  if (attributes.length > 100 || attributes.some(([key, value]) => !text(key, 128) || !text(value, 8192))) return null
  const computedStyles = input.computedStyles
  if (STYLE_KEYS.some((key) => !text(computedStyles[key], 8192))) return null
  const optional = (key: string, max = 8192) => (text(input[key], max) ? (input[key] as string) : undefined)
  return {
    tagName: input.tagName,
    textContent: input.textContent,
    outerHTML: input.outerHTML,
    cssSelector: input.cssSelector,
    attributes: Object.fromEntries(attributes) as Record<string, string>,
    bounds: new DOMRect(
      Number(bounds.x) * offset.scaleX + offset.x,
      Number(bounds.y) * offset.scaleY + offset.y,
      Number(bounds.width) * offset.scaleX,
      Number(bounds.height) * offset.scaleY,
    ),
    computedStyles: Object.fromEntries(
      STYLE_KEYS.map((key) => [key, computedStyles[key]]),
    ) as unknown as ComputedStyles,
    sourcePath: optional("sourcePath", 2048),
    sourceLine:
      typeof input.sourceLine === "number" && Number.isSafeInteger(input.sourceLine) ? input.sourceLine : undefined,
    sourceColumn:
      typeof input.sourceColumn === "number" && Number.isSafeInteger(input.sourceColumn)
        ? input.sourceColumn
        : undefined,
    isImage: input.isImage,
    imageKind:
      input.imageKind === "img" || input.imageKind === "svg" || input.imageKind === "background"
        ? input.imageKind
        : undefined,
    imageSrc: optional("imageSrc", MAX_HTML),
    imagePreview: optional("imagePreview", MAX_HTML),
    imageSvg: optional("imageSvg", 4000),
    imageAlt: optional("imageAlt"),
  }
}

export function visualChanges(input: unknown): VisualChange[] | undefined {
  if (!Array.isArray(input) || input.length > 1000) return
  const result: VisualChange[] = []
  for (const item of input) {
    if (
      !record(item) ||
      !text(item.selector, 2048) ||
      !["css", "text", "style", "attribute", "html"].includes(String(item.type))
    )
      return
    if (
      ["property", "value", "content", "inlineStyle", "sourcePath"].some(
        (key) => item[key] !== undefined && !text(item[key], MAX_HTML),
      )
    )
      return
    result.push({
      selector: item.selector,
      type: item.type as VisualChange["type"],
      property: item.property as string | undefined,
      value: item.value as string | undefined,
      content: item.content as string | undefined,
      inlineStyle: item.inlineStyle as string | undefined,
      sourcePath: item.sourcePath as string | undefined,
    })
  }
  return result
}

/** Hosted editor commands run in the preview origin. The parent accepts data snapshots, never privileged commands. */
export function createVisualBridge(input: {
  enabled: Accessor<boolean>
  setEnabled: (value: boolean) => unknown
  toggle: () => unknown
}) {
  const [state, setState] = createStore({
    iframe: null as HTMLIFrameElement | null,
    hovered: null as ElementInfo | null,
    selected: null as ElementInfo | null,
    isEditing: false,
    inlineEditing: false,
    editingText: "",
    changes: [] as VisualChange[],
    ready: false,
    error: "",
  })
  const connection = { channel: "", origin: "", next: 0 }
  const queued: Array<Record<string, unknown>> = []
  const requests = new Map<
    number,
    { resolve: (html: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >()
  const rejectRequests = (message: string) => {
    requests.forEach((request) => {
      clearTimeout(request.timeout)
      request.reject(new Error(message))
    })
    requests.clear()
  }
  const post = (value: Record<string, unknown>) => {
    if (!state.ready) {
      if (queued.length >= 100) {
        setState("error", "The preview editor is not responding. Reload the preview.")
        return
      }
      queued.push(value)
      return
    }
    state.iframe?.contentWindow?.postMessage(
      { type: "omai:visual:command", channel: connection.channel, ...value },
      connection.origin,
    )
  }
  createEffect(() => {
    const iframe = state.iframe
    if (!iframe) return
    const initialize = () => {
      rejectRequests("The preview changed before the save completed.")
      queued.length = 0
      setState({ ready: false, selected: null, hovered: null, changes: [], error: "" })
      const origin = new URL(iframe.src, location.href).origin
      if (origin === location.origin || origin === "null") {
        setState("error", "The hosted visual editor requires an isolated preview address.")
        return
      }
      connection.origin = origin
      connection.channel = crypto.randomUUID()
      iframe.contentWindow?.postMessage({ type: "omai:visual:init", channel: connection.channel }, origin)
    }
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== connection.origin ||
        !record(event.data) ||
        event.data.channel !== connection.channel
      )
        return
      const data = event.data
      if (data.type === "omai:visual:ready") {
        setState({ ready: true, error: "" })
        post({ command: "enable", value: input.enabled() })
        queued.splice(0).forEach(post)
        return
      }
      if (data.type === "omai:visual:error" && text(data.error, 2048)) {
        setState("error", data.error)
        const request = typeof data.requestID === "number" ? requests.get(data.requestID) : undefined
        if (request) {
          clearTimeout(request.timeout)
          requests.delete(Number(data.requestID))
          request.reject(new Error(data.error))
        }
        return
      }
      if (data.type === "omai:visual:html" && typeof data.requestID === "number" && text(data.html, MAX_HTML)) {
        const request = requests.get(data.requestID)
        if (!request) return
        clearTimeout(request.timeout)
        requests.delete(data.requestID)
        request.resolve(data.html)
        return
      }
      if (
        data.type !== "omai:visual:state" ||
        typeof data.isEditing !== "boolean" ||
        typeof data.inlineEditing !== "boolean" ||
        !text(data.editingText)
      )
        return
      const changes = visualChanges(data.changes)
      if (!changes) return
      const rect = iframe.getBoundingClientRect()
      const offset = {
        x: rect.x,
        y: rect.y,
        scaleX: iframe.clientWidth ? rect.width / iframe.clientWidth : 1,
        scaleY: iframe.clientHeight ? rect.height / iframe.clientHeight : 1,
      }
      const selected = data.selected === null ? null : visualElement(data.selected, offset)
      const hovered = data.hovered === null ? null : visualElement(data.hovered, offset)
      if ((data.selected !== null && !selected) || (data.hovered !== null && !hovered)) return
      batch(() =>
        setState({
          selected,
          hovered,
          isEditing: data.isEditing as boolean,
          inlineEditing: data.inlineEditing as boolean,
          editingText: data.editingText as string,
          changes,
        }),
      )
    }
    window.addEventListener("message", receive)
    iframe.addEventListener("load", initialize)
    initialize()
    const retry = setInterval(() => {
      if (!state.ready && connection.origin)
        iframe.contentWindow?.postMessage({ type: "omai:visual:init", channel: connection.channel }, connection.origin)
    }, 1000)
    onCleanup(() => {
      clearInterval(retry)
      iframe.removeEventListener("load", initialize)
      window.removeEventListener("message", receive)
      rejectRequests("The preview was closed.")
    })
  })
  createEffect(() => {
    post({ command: "enable", value: input.enabled() })
  })
  const textChange = (command: string, value: string) => {
    setState("editingText", value)
    post({ command, value })
  }
  return {
    enabled: input.enabled,
    setEnabled: input.setEnabled,
    toggle: input.toggle,
    hoveredElement: () => state.hovered,
    setHoveredElement: (element: ElementInfo | null) => setState("hovered", element),
    selectedElement: () => state.selected,
    setSelectedElement: (element: ElementInfo | null) =>
      post({ command: "select", selector: element?.cssSelector ?? null }),
    clearSelection: () => post({ command: "clearSelection" }),
    isEditing: () => state.isEditing,
    inlineEditing: () => state.inlineEditing,
    editingText: () => state.editingText,
    setEditingText: (value: string) => textChange("editingText", value),
    startEditing: (_element: ElementInfo) => post({ command: "startEditing" }),
    stopEditing: (value = state.editingText) => post({ command: "stopEditing", value }),
    cancelEditing: () => post({ command: "cancelEditing" }),
    applyCssProperty: (property: string, value: string) => post({ command: "css", property, value }),
    applyAttribute: (property: string, value: string) => post({ command: "attribute", property, value }),
    replaceImageSource: (src: string, link?: string) => post({ command: "image", src, link }),
    recordTextChange: (value: string) => textChange("text", value),
    refreshSelectedStyles: () => post({ command: "refresh" }),
    iframeRef: () => state.iframe,
    setIframeRef: (iframe: HTMLIFrameElement | null) => setState("iframe", iframe),
    pendingChanges: () => state.changes,
    clearChanges: () => post({ command: "clearChanges" }),
    bridgeError: () => state.error,
    collectModifiedHtml: async () => {
      if (!state.ready) throw new Error(state.error || "The visual editor is still connecting to the preview.")
      const requestID = ++connection.next
      const pending = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          requests.delete(requestID)
          reject(new Error("The preview did not respond. Your edits have not been saved."))
        }, 10_000)
        requests.set(requestID, { resolve, reject, timeout })
      })
      post({ command: "collect", requestID })
      return pending
    },
  }
}
