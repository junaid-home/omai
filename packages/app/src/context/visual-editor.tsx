import { centralRuntime } from "@/utils/central-state"
import { createVisualBridge } from "@/utils/visual-bridge"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import Moveable from "moveable"
import Selecto from "selecto"

export interface ComputedStyles {
  fontSize: string
  fontWeight: string
  fontStyle: string
  fontFamily: string
  color: string
  backgroundColor: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  marginTop: string
  marginRight: string
  marginBottom: string
  marginLeft: string
  textAlign: string
  lineHeight: string
  letterSpacing: string
  borderRadius: string
  border: string
  opacity: string
}

export interface ElementInfo {
  tagName: string
  textContent: string
  outerHTML: string
  attributes: Record<string, string>
  bounds: DOMRect
  cssSelector: string
  computedStyles: ComputedStyles
  sourcePath?: string
  sourceLine?: number
  sourceColumn?: number
  isImage: boolean
  imageKind?: "img" | "background" | "svg"
  imageSrc?: string
  imagePreview?: string
  imageSvg?: string
  imageAlt?: string
}

export interface VisualChange {
  selector: string
  type: "css" | "text" | "style" | "attribute" | "html"
  property?: string
  value?: string
  content?: string
  inlineStyle?: string
  sourcePath?: string
}

const [globalEnabled, setGlobalEnabled] = createSignal(false)
export const toggleVisualEditor = () => setGlobalEnabled((p) => !p)
export const isVisualEditorEnabled = globalEnabled

function buildCssSelector(el: Element, doc: Document): string {
  if (el.id) return `#${el.id}`
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== doc.body && parts.length < 5) {
    let selector = current.tagName.toLowerCase()
    if (current.id) {
      parts.unshift(`#${current.id}`)
      break
    }
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName)
      if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(selector)
    current = current.parentElement
  }
  return parts.join(" > ")
}

const STYLE_KEYS: (keyof ComputedStyles)[] = [
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
]

function readComputedStyles(el: Element): ComputedStyles {
  try {
    const cs = getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const key of STYLE_KEYS)
      out[key] = cs.getPropertyValue(
        key === "backgroundColor" ? "background-color" : key.replace(/([A-Z])/g, "-$1").toLowerCase(),
      )
    return out as unknown as ComputedStyles
  } catch {
    return {} as ComputedStyles
  }
}

function detectImage(el: Element): {
  isImage: boolean
  imageKind?: "img" | "background" | "svg"
  imageSrc?: string
  imagePreview?: string
  imageSvg?: string
  imageAlt?: string
} {
  const tag = el.tagName.toLowerCase()
  if (tag === "img") {
    const img = el as HTMLImageElement
    const raw = img.getAttribute("data-ve-src") ?? img.getAttribute("src") ?? img.currentSrc ?? ""
    return {
      isImage: true,
      imageKind: "img",
      imageSrc: raw,
      imagePreview: img.currentSrc || img.src || raw,
      imageAlt: img.alt ?? "",
    }
  }
  if (tag === "svg" || el instanceof SVGSVGElement) {
    return { isImage: true, imageKind: "svg", imageSvg: el.outerHTML.slice(0, 4000) }
  }
  try {
    const backgroundImage = getComputedStyle(el).backgroundImage
    if (backgroundImage && backgroundImage !== "none") {
      const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)
      if (match) {
        const href = new URL(match[1], el.ownerDocument.baseURI)
        return {
          isImage: true,
          imageKind: "background",
          imageSrc: el.getAttribute("data-ve-src") ?? match[1],
          imagePreview: href.href,
        }
      }
    }
  } catch {}
  return { isImage: false }
}

function buildElementInfo(el: Element): ElementInfo | null {
  try {
    const r = el.getBoundingClientRect()
    const attrs: Record<string, string> = {}
    for (let i = 0; i < el.attributes.length; i++) {
      attrs[el.attributes[i].name] = el.attributes[i].value
    }
    const image = detectImage(el)
    return {
      tagName: el.tagName.toLowerCase(),
      textContent: (el.textContent ?? "").trim().slice(0, 500),
      outerHTML: el.outerHTML.slice(0, 2000),
      attributes: attrs,
      bounds: new DOMRect(r.x, r.y, r.width, r.height),
      cssSelector: buildCssSelector(el, el.ownerDocument),
      computedStyles: readComputedStyles(el),
      sourcePath: el.getAttribute("data-insp-path") ?? undefined,
      sourceLine: el.getAttribute("data-insp-row") ? Number(el.getAttribute("data-insp-row")) : undefined,
      sourceColumn: el.getAttribute("data-insp-col") ? Number(el.getAttribute("data-insp-col")) : undefined,
      ...image,
    }
  } catch {
    return null
  }
}

function isVeOverlay(el: Element): boolean {
  return el.id === "ve-ov" || el.id === "ve-hov" || el.id === "ve-tip" || !!el.closest?.("#ve-ov, #ve-hov, #ve-tip")
}

export const { use: useVisualEditor, provider: VisualEditorProvider } = createSimpleContext({
  name: "VisualEditor",
  gate: false,
  init: () => {
    if (centralRuntime.get().mode === "central")
      return createVisualBridge({ enabled: globalEnabled, setEnabled: setGlobalEnabled, toggle: toggleVisualEditor })
    const [hoveredElement, setHoveredElement] = createSignal<ElementInfo | null>(null)
    const [selectedElement, setSelectedElement] = createSignal<ElementInfo | null>(null)
    const [isEditing, setIsEditing] = createSignal(false)
    const [inlineEditing, setInlineEditing] = createSignal(false)
    const [editingText, setEditingText] = createSignal("")
    const [iframeRef, setIframeRef] = createSignal<HTMLIFrameElement | null>(null)
    const [pendingChanges, setPendingChanges] = createSignal<VisualChange[]>([])

    const enabled = globalEnabled
    const setEnabled = setGlobalEnabled
    const toggle = toggleVisualEditor
    let moveable: Moveable | null = null
    let moveableUpdateTimer: ReturnType<typeof setInterval> | undefined
    let selecto: Selecto | null = null
    let activeHovered: Element | null = null
    let activeSelected: Element | null = null

    const isIframeReady = (iframe: HTMLIFrameElement): boolean => {
      try {
        const doc = iframe.contentDocument
        return !!doc && !!doc.body && doc.readyState !== "loading"
      } catch {
        return false
      }
    }

    const getIframeDoc = (iframe: HTMLIFrameElement): Document | null => {
      try {
        return iframe.contentDocument
      } catch {
        return null
      }
    }

    const getIframeBody = (iframe: HTMLIFrameElement): HTMLElement | null => {
      try {
        return iframe.contentDocument?.body ?? null
      } catch {
        return null
      }
    }

    function onMouseOver(e: MouseEvent) {
      if (!enabled()) return
      const t = e.target as Element
      if (!t || t === document.body || t === document.documentElement) return
      if (isVeOverlay(t)) return
      if (activeHovered === t) return
      activeHovered = t
      setHoveredElement(buildElementInfo(t))
    }

    function onMouseOut(e: MouseEvent) {
      if (!enabled()) return
      const t = e.target as Element
      const related = e.relatedTarget as Element | null
      if (related && activeHovered && activeHovered.contains(related)) return
      activeHovered = null
      setHoveredElement(null)
    }

    function onClick(e: MouseEvent) {
      if (!enabled()) return
      const t = e.target as Element
      if (!t || t === document.body || t === document.documentElement) return
      if (isVeOverlay(t)) return
      e.preventDefault()
      e.stopPropagation()
      const info = buildElementInfo(t)
      activeSelected = t
      if (info) {
        batch(() => {
          setSelectedElement(info)
          setIsEditing(false)
          setEditingText("")
        })
        updateMoveableTarget()
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!enabled()) return
      if (e.key === "Escape") {
        finishInlineEdit()
        if (activeSelected) {
          activeSelected = null
          batch(() => {
            setSelectedElement(null)
            setIsEditing(false)
            setInlineEditing(false)
            setEditingText("")
          })
          updateMoveableTarget()
        }
      }
    }

    function onDblClick(e: MouseEvent) {
      if (!enabled()) return
      const t = e.target as HTMLElement
      if (!t || t === document.body || t === document.documentElement) return
      if (isVeOverlay(t)) return
      startInlineEdit(t)
    }

    function startInlineEdit(el: HTMLElement) {
      if (!enabled()) return
      const info = buildElementInfo(el)
      if (!info) return
      activeSelected = el
      batch(() => {
        setSelectedElement(info)
        setIsEditing(true)
        setInlineEditing(true)
        setEditingText(info.textContent)
      })
      updateMoveableTarget()

      try {
        const iframe = iframeRef()!
        const doc = getIframeDoc(iframe)
        const body = getIframeBody(iframe)
        if (!doc || !body) return

        el.contentEditable = "true"
        el.focus()
        const sel = doc.getSelection()
        if (sel) {
          const range = doc.createRange()
          range.selectNodeContents(el)
          sel.removeAllRanges()
          sel.addRange(range)
        }

        const onBlur = () => {
          el.removeEventListener("blur", onBlur)
          el.removeEventListener("keydown", onEditKey)
          el.contentEditable = "false"
          const newText = (el.textContent ?? "").trim()
          batch(() => {
            setEditingText(newText)
            setIsEditing(false)
            setInlineEditing(false)
          })
          const updated = buildElementInfo(el)
          if (updated) setSelectedElement(updated)
          updateMoveableTarget()
        }

        const onEditKey = (ke: KeyboardEvent) => {
          if (ke.key === "Escape") {
            ke.preventDefault()
            ke.stopPropagation()
            el.removeEventListener("blur", onBlur)
            el.removeEventListener("keydown", onEditKey)
            ;(el as HTMLElement).contentEditable = "false"
            batch(() => {
              setIsEditing(false)
              setInlineEditing(false)
            })
          }
          if (ke.key === "Enter" && !ke.shiftKey) {
            ke.preventDefault()
            ke.stopPropagation()
            el.blur()
          }
        }

        el.addEventListener("blur", onBlur)
        el.addEventListener("keydown", onEditKey, true)
      } catch {}
    }

    function finishInlineEdit() {
      const el = activeSelected as HTMLElement | null
      if (el?.getAttribute("contenteditable") === "true") {
        el.contentEditable = "false"
      }
    }

    function attachListeners(iframe: HTMLIFrameElement) {
      const doc = getIframeDoc(iframe)
      const win = iframe.contentWindow
      if (!doc || !win) return
      doc.addEventListener("mouseover", onMouseOver, true)
      doc.addEventListener("mouseout", onMouseOut, true)
      doc.addEventListener("click", onClick, true)
      doc.addEventListener("dblclick", onDblClick, true)
      win.addEventListener("keydown", onKeyDown, true)
    }

    function detachListeners(iframe: HTMLIFrameElement) {
      const doc = getIframeDoc(iframe)
      const win = iframe.contentWindow
      if (!doc || !win) return
      doc.removeEventListener("mouseover", onMouseOver, true)
      doc.removeEventListener("mouseout", onMouseOut, true)
      doc.removeEventListener("click", onClick, true)
      doc.removeEventListener("dblclick", onDblClick, true)
      win.removeEventListener("keydown", onKeyDown, true)
    }

    const startEditing = (element: ElementInfo) => {
      batch(() => {
        setSelectedElement(element)
        setIsEditing(true)
        setInlineEditing(false)
        setEditingText(element.textContent)
      })
      const iframe = iframeRef()
      if (iframe)
        try {
          iframe.blur()
        } catch {}
    }

    const stopEditing = (newText?: string) => {
      const el = selectedElement()
      if (isEditing() && el) {
        const text = newText ?? editingText()
        try {
          const doc = getIframeDoc(iframeRef()!)
          const target = doc?.querySelector(el.cssSelector)
          if (target) {
            target.textContent = text
            upsertChange({
              selector: el.cssSelector,
              type: "text",
              content: text,
              sourcePath: el.sourcePath,
            })
          }
        } catch {}
      }
      batch(() => {
        setIsEditing(false)
        setInlineEditing(false)
      })
    }

    const cancelEditing = () => {
      finishInlineEdit()
      batch(() => {
        setIsEditing(false)
        setInlineEditing(false)
        setEditingText("")
      })
    }

    const selectElement = (element: ElementInfo | null) => {
      batch(() => {
        setSelectedElement(element)
        setIsEditing(false)
        setInlineEditing(false)
        setEditingText("")
      })
      updateMoveableTarget()
    }

    const clearSelection = () => {
      finishInlineEdit()
      activeSelected = null
      batch(() => {
        setSelectedElement(null)
        setIsEditing(false)
        setInlineEditing(false)
        setEditingText("")
      })
      updateMoveableTarget()
    }

    const applyCssProperty = (property: string, value: string) => {
      const el = selectedElement()
      if (!el) return
      try {
        const doc = getIframeDoc(iframeRef()!)
        const target = doc?.querySelector(el.cssSelector)
        if (target) {
          ;(target as HTMLElement).style.setProperty(property, value)
          upsertChange({
            selector: el.cssSelector,
            type: "css",
            property,
            value,
            sourcePath: el.sourcePath,
          })
        }
      } catch {}
    }

    const applyAttribute = (prop: string, value: string) => {
      const el = selectedElement()
      if (!el) return
      try {
        const doc = getIframeDoc(iframeRef()!)
        const target = doc?.querySelector(el.cssSelector)
        if (target) {
          target.setAttribute(prop, value)
          upsertChange({
            selector: el.cssSelector,
            type: "attribute",
            property: prop,
            value,
            sourcePath: el.sourcePath,
          })
        }
      } catch {}
    }

    const replaceImageSource = (src: string, link?: string) => {
      const el = selectedElement()
      if (!el || !el.isImage) return
      const saveSrc = link ?? src
      try {
        const doc = getIframeDoc(iframeRef()!)
        const target = doc?.querySelector(el.cssSelector)
        if (!doc || !target) return
        if (el.imageKind === "svg") {
          const prevRect = target.getBoundingClientRect()
          const img = doc.createElement("img")
          img.alt = el.imageAlt ?? ""
          if ((target as HTMLElement).id) img.id = (target as HTMLElement).id
          if (target.className && typeof target.className === "string") img.className = target.className
          if (prevRect.width > 0 || prevRect.height > 0) {
            img.style.maxWidth = "100%"
            img.style.maxHeight = "100%"
            img.style.width = `${prevRect.width}px`
            img.style.height = `${prevRect.height}px`
            img.style.objectFit = "contain"
          }
          img.setAttribute("data-ve-src", saveSrc)
          img.setAttribute("src", saveSrc)
          img.removeAttribute("data-ve-src")
          const replaceContent = img.outerHTML
          img.setAttribute("data-ve-src", saveSrc)
          img.setAttribute("src", src)
          target.replaceWith(img)
          upsertChange({
            selector: el.cssSelector,
            type: "html",
            content: replaceContent,
            sourcePath: el.sourcePath,
          })
          const updated = buildElementInfo(img)
          if (updated) setSelectedElement(updated)
          updateMoveableTarget()
        } else if (el.imageKind === "background") {
          ;(target as HTMLElement).style.backgroundImage = `url("${src}")`
          target.setAttribute("data-ve-src", saveSrc)
          upsertChange({
            selector: el.cssSelector,
            type: "css",
            property: "background-image",
            value: `url("${saveSrc}")`,
            sourcePath: el.sourcePath,
          })
          refreshSelectedStyles()
        } else {
          const prevRect = target.getBoundingClientRect()
          const hadSrcset = target.hasAttribute("srcset")
          target.removeAttribute("srcset")
          target.removeAttribute("sizes")
          if (prevRect.width > 0 || prevRect.height > 0) {
            ;(target as HTMLElement).style.maxWidth = `${prevRect.width}px`
            ;(target as HTMLElement).style.maxHeight = `${prevRect.height}px`
            ;(target as HTMLElement).style.objectFit = "contain"
          }
          target.setAttribute("data-ve-src", saveSrc)
          target.setAttribute("src", src)
          if (hadSrcset) {
            upsertChange({
              selector: el.cssSelector,
              type: "attribute",
              property: "srcset",
              value: "",
              sourcePath: el.sourcePath,
            })
          }
          upsertChange({
            selector: el.cssSelector,
            type: "attribute",
            property: "src",
            value: saveSrc,
            sourcePath: el.sourcePath,
          })
          const updated = buildElementInfo(target)
          if (updated) setSelectedElement(updated)
        }
      } catch {}
    }

    const recordTextChange = (newText: string) => {
      const el = selectedElement()
      if (!el) return
      try {
        const doc = getIframeDoc(iframeRef()!)
        const target = doc?.querySelector(el.cssSelector)
        if (target) {
          target.textContent = newText
          upsertChange({
            selector: el.cssSelector,
            type: "text",
            content: newText,
            sourcePath: el.sourcePath,
          })
        }
      } catch {}
    }

    const refreshSelectedStyles = () => {
      const el = selectedElement()
      if (!el) return
      try {
        const doc = getIframeDoc(iframeRef()!)
        const target = doc?.querySelector(el.cssSelector)
        if (target) {
          const updated = buildElementInfo(target)
          if (updated) setSelectedElement(updated)
        }
      } catch {}
    }

    const clearChanges = () => setPendingChanges([])

    const upsertChange = (change: VisualChange) =>
      setPendingChanges((prev) => {
        const index = prev.findLastIndex(
          (c) =>
            c.selector === change.selector &&
            c.type === change.type &&
            (change.property !== undefined && c.property !== undefined ? c.property === change.property : true),
        )
        if (index === -1) return [...prev, change]
        const next = [...prev]
        next[index] = change
        return next
      })

    const collectModifiedHtml = (): string | null => {
      const iframe = iframeRef()
      if (!iframe) return null
      try {
        const doc = getIframeDoc(iframe)
        if (!doc) return null
        return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
      } catch {
        return null
      }
    }

    const setEnabledState = (value: boolean) => {
      setEnabled(value)
      const iframe = iframeRef()
      if (!iframe) return
      if (value) {
        if (isIframeReady(iframe)) {
          attachListeners(iframe)
        }
        setupMoveable()
        setupSelecto()
      } else {
        detachListeners(iframe)
        destroyMoveable()
        destroySelecto()
        activeHovered = null
        activeSelected = null
        batch(() => {
          setSelectedElement(null)
          setIsEditing(false)
          setEditingText("")
          setHoveredElement(null)
        })
      }
    }

    function updateMoveableTarget() {
      if (!moveable) return
      const sel = selectedElement()
      if (!sel) {
        moveable.target = []
        return
      }
      const iframe = iframeRef()
      if (!iframe) return
      const doc = getIframeDoc(iframe)
      if (!doc) return
      const target = doc.querySelector(sel.cssSelector)
      if (target) moveable.target = [target as HTMLElement]
      else moveable.target = []
    }

    function setupMoveable() {
      const iframe = iframeRef()
      if (!iframe) return
      const body = getIframeBody(iframe)
      if (!body) return
      destroyMoveable()

      moveable = new Moveable(body, {
        target: [],
        draggable: true,
        resizable: true,
        origin: false,
        keepRatio: false,
        throttleDrag: 0,
        throttleResize: 0,
      })

      moveableUpdateTimer = setInterval(() => {
        if (moveable) moveable.updateRect()
      }, 100)

      moveable.on("dragStart", (e) => {
        e.inputEvent.stopPropagation()
        e.inputEvent.preventDefault()
      })

      moveable.on("drag", (e) => {
        e.target.style.transform = e.transform
      })

      moveable.on("dragEnd", (e) => {
        if (e.lastEvent) {
          e.target.setAttribute("style", e.target.getAttribute("style") ?? "")
          const selector = buildCssSelector(e.target, e.target.ownerDocument)
          upsertChange({
            selector,
            type: "style",
            inlineStyle: e.target.getAttribute("style") ?? "",
          })
        }
      })

      moveable.on("resizeStart", (e) => {
        e.inputEvent.stopPropagation()
        e.inputEvent.preventDefault()
      })

      moveable.on("resize", (e) => {
        e.target.style.width = `${e.width}px`
        e.target.style.height = `${e.height}px`
        e.target.style.transform = e.drag.transform
      })

      moveable.on("resizeEnd", (e) => {
        const selector = buildCssSelector(e.target, e.target.ownerDocument)
        upsertChange({
          selector,
          type: "style",
          inlineStyle: e.target.getAttribute("style") ?? "",
        })
      })
    }

    function destroyMoveable() {
      if (moveableUpdateTimer) {
        clearInterval(moveableUpdateTimer)
        moveableUpdateTimer = undefined
      }
      if (moveable) {
        moveable.destroy()
        moveable = null
      }
    }

    function setupSelecto() {
      const iframe = iframeRef()
      if (!iframe?.contentDocument?.body || !iframe.contentWindow) return
      destroySelecto()

      selecto = new Selecto({
        container: iframe.contentDocument.body,
        dragContainer: iframe.contentWindow,
        selectableTargets: [".ve-target"],
        selectByClick: true,
        hitRate: 0,
      })

      selecto.on("selectEnd", (e) => {
        if (e.selected.length === 1) {
          const el = e.selected[0]
          const info = buildElementInfo(el)
          if (info) selectElement(info)
        }
      })
    }

    function destroySelecto() {
      if (selecto) {
        selecto.destroy()
        selecto = null
      }
    }

    createEffect(
      on(iframeRef, (iframe) => {
        if (!iframe) return
        let timer: ReturnType<typeof setInterval> | undefined
        let listenersAttached = false
        const cleanup = () => {
          clearInterval(timer)
          timer = undefined
        }

        const tryAttach = () => {
          if (!isIframeReady(iframe)) return false
          cleanup()
          if (!listenersAttached && enabled()) {
            attachListeners(iframe)
            listenersAttached = true
          }
          return true
        }

        if (!tryAttach()) {
          timer = setInterval(tryAttach, 200)
          onCleanup(cleanup)
        }
      }),
    )

    createEffect(
      on(enabled, (isEnabled) => {
        const iframe = iframeRef()
        if (!iframe) return
        if (isEnabled) {
          if (isIframeReady(iframe)) attachListeners(iframe)
          setupMoveable()
          setupSelecto()
        } else {
          detachListeners(iframe)
          destroyMoveable()
          destroySelecto()
          activeHovered = null
          activeSelected = null
          batch(() => {
            setSelectedElement(null)
            setIsEditing(false)
            setInlineEditing(false)
            setEditingText("")
            setHoveredElement(null)
          })
        }
      }),
    )

    return {
      enabled,
      setEnabled: setEnabledState,
      toggle,
      hoveredElement,
      setHoveredElement,
      selectedElement,
      setSelectedElement: selectElement,
      clearSelection,
      isEditing,
      inlineEditing,
      editingText,
      setEditingText,
      startEditing,
      stopEditing,
      cancelEditing,
      applyCssProperty,
      applyAttribute,
      replaceImageSource,
      recordTextChange,
      refreshSelectedStyles,
      iframeRef,
      setIframeRef,
      pendingChanges,
      clearChanges,
      collectModifiedHtml,
      bridgeError: () => "",
    }
  },
})

export const requestImageReplace = () => {
  window.dispatchEvent(new CustomEvent("ve-request-image-replace"))
}
