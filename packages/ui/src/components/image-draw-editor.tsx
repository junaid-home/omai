import { createSignal, For, onMount, onCleanup, createMemo } from "solid-js"
import { useI18n } from "../context/i18n"

export interface ImageDrawEditorProps {
  src: string
  onSave: (dataUrl: string) => void
  onCancel: () => void
}

const COLORS = ["#000000", "#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ffffff"]

const isRemote = (src: string) => src.startsWith("/file/") || /^https?:\/\//.test(src)

const cacheBust = (src: string) =>
  isRemote(src) ? `${src}${src.includes("?") ? "&" : "?"}__cb=${Math.random().toString(36).slice(2)}` : src

export function ImageDrawEditor(props: ImageDrawEditorProps) {
  const i18n = useI18n()
  let canvas!: HTMLCanvasElement
  let img!: HTMLImageElement
  let frame!: HTMLDivElement

  const [brushColor, setBrushColor] = createSignal("#ef4444")
  const [brushSize, setBrushSize] = createSignal(4)
  const [undoStack, setUndoStack] = createSignal<string[]>([])
  const [drawing, setDrawing] = createSignal(false)

  const imgSrc = createMemo(() => cacheBust(props.src))

  let lastX = 0
  let lastY = 0

  const ctx = () => canvas.getContext("2d")!

  const pushUndo = () => {
    setUndoStack((prev) => [...prev.slice(-29), canvas.toDataURL()])
  }

  const stroke = (x: number, y: number) => {
    const c = ctx()
    c.beginPath()
    c.moveTo(lastX, lastY)
    c.lineTo(x, y)
    c.strokeStyle = brushColor()
    c.lineWidth = brushSize()
    c.lineCap = "round"
    c.lineJoin = "round"
    c.stroke()
    lastX = x
    lastY = y
  }

  const getCoords = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  const syncCanvasSize = () => {
    const nw = img.naturalWidth || 1
    const nh = img.naturalHeight || 1
    const frameRect = frame.getBoundingClientRect()
    const fw = Math.max(1, frameRect.width)
    const fh = Math.max(1, frameRect.height)
    const imgAspect = nw / nh
    const frameAspect = fw / fh
    let w: number
    let h: number
    if (imgAspect > frameAspect) {
      w = Math.round(fw)
      h = Math.round(fw / imgAspect)
    } else {
      h = Math.round(fh)
      w = Math.round(fh * imgAspect)
    }
    canvas.width = Math.max(nw, w)
    canvas.height = Math.max(nh, h)
  }

  const onDown = (e: PointerEvent) => {
    e.preventDefault()
    pushUndo()
    const { x, y } = getCoords(e)
    lastX = x
    lastY = y
    setDrawing(true)
    canvas.setPointerCapture(e.pointerId)
  }

  const onMove = (e: PointerEvent) => {
    if (!drawing()) return
    const { x, y } = getCoords(e)
    stroke(x, y)
  }

  const onUp = (e: PointerEvent) => {
    if (!drawing()) return
    setDrawing(false)
    canvas.releasePointerCapture(e.pointerId)
  }

  const onUndo = () => {
    const stack = undoStack()
    if (stack.length === 0) return
    const prev = stack[stack.length - 1]
    const image = new Image()
    image.onload = () => {
      ctx().clearRect(0, 0, canvas.width, canvas.height)
      ctx().drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    image.src = prev
    setUndoStack((s) => s.slice(0, -1))
  }

  const onSave = () => {
    try {
      if (img.complete && img.naturalWidth > 0) {
        const composite = document.createElement("canvas")
        composite.width = canvas.width
        composite.height = canvas.height
        const c = composite.getContext("2d")!
        c.drawImage(img, 0, 0, canvas.width, canvas.height)
        c.drawImage(canvas, 0, 0)
        props.onSave(composite.toDataURL("image/png"))
        return
      }
      props.onSave(canvas.toDataURL("image/png"))
    } catch (e) {
      props.onSave(canvas.toDataURL("image/png"))
    }
  }

  const onResize = () => {
    if (!img.complete || img.naturalWidth === 0) return
    const prevData = canvas.toDataURL()
    syncCanvasSize()
    const image = new Image()
    image.onload = () => {
      ctx().drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    image.src = prevData
  }

  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(onResize)
      ro.observe(frame)
      ro.observe(img)
    }
    requestAnimationFrame(() => {
      if (img.complete && img.naturalWidth > 0) syncCanvasSize()
    })
  })

  onCleanup(() => {
    setUndoStack([])
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault()
      onUndo()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      props.onCancel()
    }
  }

  return (
    <div
      data-component="image-draw-editor"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t("ui.imageDrawEditor.title")}
    >
      <div data-slot="image-draw-editor-header">
        <div data-slot="image-draw-editor-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M11 1.5L14.5 5L6 13.5H2.5V10L11 1.5Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {i18n.t("ui.imageDrawEditor.title")}
        </div>

        <div data-slot="image-draw-editor-header-actions">
          <button
            type="button"
            data-slot="image-draw-editor-btn"
            data-action="undo"
            disabled={undoStack().length === 0}
            onClick={onUndo}
          >
            {i18n.t("ui.imageDrawEditor.undo")}
          </button>
          <button type="button" data-slot="image-draw-editor-btn" data-action="cancel" onClick={props.onCancel}>
            {i18n.t("ui.imageDrawEditor.cancel")}
          </button>
          <button type="button" data-slot="image-draw-editor-btn" data-action="save" onClick={onSave}>
            {i18n.t("ui.imageDrawEditor.save")}
          </button>
        </div>
      </div>

      <div data-slot="image-draw-editor-canvas-wrap">
        <div data-slot="image-draw-editor-frame" ref={frame}>
          <img
            ref={img}
            src={imgSrc()}
            alt=""
            draggable={false}
            crossorigin={isRemote(props.src) ? "anonymous" : undefined}
            data-slot="image-draw-editor-img"
            onDragStart={(e) => e.preventDefault()}
            onLoad={() => syncCanvasSize()}
          />
          <canvas
            ref={canvas}
            data-slot="image-draw-editor-canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            style={{ cursor: "crosshair" }}
          />
        </div>
      </div>

      <div data-slot="image-draw-editor-toolbar">
        <div data-slot="image-draw-editor-colors">
          <For each={COLORS}>
            {(color) => (
              <button
                type="button"
                data-slot="image-draw-editor-swatch"
                data-active={brushColor() === color ? "" : undefined}
                style={{ "background-color": color }}
                onClick={() => setBrushColor(color)}
                aria-label={i18n.t("ui.imageDrawEditor.color", { color })}
              />
            )}
          </For>
        </div>

        <span data-slot="image-draw-editor-brush">
          <span data-slot="image-draw-editor-size-label" aria-hidden="true">
            {brushSize()}
          </span>
          <input
            type="range"
            min="1"
            max="20"
            value={brushSize()}
            onInput={(e) => setBrushSize(Number(e.currentTarget.value))}
            data-slot="image-draw-editor-size"
            aria-label={i18n.t("ui.imageDrawEditor.brushSize")}
          />
        </span>
      </div>
    </div>
  )
}
