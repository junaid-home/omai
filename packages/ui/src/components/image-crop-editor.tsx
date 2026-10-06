import { createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js"
import { useI18n } from "../context/i18n"

export interface ImageCropEditorProps {
  src: string
  onSave: (dataUrl: string) => void
  onCancel: () => void
}

const isRemote = (src: string) => src.startsWith("/file/") || /^https?:\/\//.test(src)

const cacheBust = (src: string) =>
  isRemote(src) ? `${src}${src.includes("?") ? "&" : "?"}__cb=${Math.random().toString(36).slice(2)}` : src

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function ImageCropEditor(props: ImageCropEditorProps) {
  const i18n = useI18n()
  let canvas!: HTMLCanvasElement
  let img!: HTMLImageElement
  let frame!: HTMLDivElement

  const [crop, setCrop] = createSignal<Box | null>(null)
  const [dragging, setDragging] = createSignal(false)
  const [startPos, setStartPos] = createSignal({ x: 0, y: 0 })

  const imgSrc = createMemo(() => cacheBust(props.src))

  createEffect(() => {
    imgSrc()
    setCrop(null)
    setDragging(false)
  })

  const getCoords = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const syncCanvasSize = () => {
    const nw = img.naturalWidth
    const nh = img.naturalHeight

    if (nw > 0 && nh > 0) {
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
    } else {
      const frameRect = frame.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(frameRect.width))
      canvas.height = Math.max(1, Math.round(frameRect.height))
    }
  }

  const drawImage = () => {
    const c = canvas.getContext("2d")!
    syncCanvasSize()
    const w = canvas.width
    const h = canvas.height
    c.drawImage(img, 0, 0, w, h)
    drawOverlay()
  }

  const drawOverlay = () => {
    const c = canvas.getContext("2d")!
    const w = canvas.width
    const h = canvas.height
    const box = crop()

    c.fillStyle = "#0f172a"
    c.fillRect(0, 0, w, h)
    c.drawImage(img, 0, 0, w, h)

    if (!box) return

    c.fillStyle = "rgba(0, 0, 0, 0.5)"
    c.fillRect(0, 0, w, h)

    c.save()
    c.beginPath()
    c.rect(box.x, box.y, box.w, box.h)
    c.clip()
    c.drawImage(img, 0, 0, w, h)
    c.restore()

    c.strokeStyle = "#ffffff"
    c.lineWidth = 2
    c.setLineDash([6, 4])
    c.strokeRect(box.x, box.y, box.w, box.h)
    c.setLineDash([])

    const thirdW = box.w / 3
    const thirdH = box.h / 3
    c.strokeStyle = "rgba(255, 255, 255, 0.4)"
    c.lineWidth = 1
    for (let i = 1; i <= 2; i++) {
      c.beginPath()
      c.moveTo(box.x + thirdW * i, box.y)
      c.lineTo(box.x + thirdW * i, box.y + box.h)
      c.stroke()
      c.beginPath()
      c.moveTo(box.x, box.y + thirdH * i)
      c.lineTo(box.x + box.w, box.y + thirdH * i)
      c.stroke()
    }
  }

  let ro: ResizeObserver | undefined

  const initCrop = () => {
    syncCanvasSize()
    const w = canvas.width
    const h = canvas.height
    const margin = 0.1
    setCrop({
      x: Math.round(w * margin),
      y: Math.round(h * margin),
      w: Math.round(w * (1 - 2 * margin)),
      h: Math.round(h * (1 - 2 * margin)),
    })
    drawImage()
  }

  onMount(() => {
    img.onload = () => requestAnimationFrame(initCrop)
    if (img.complete && img.naturalWidth > 0) requestAnimationFrame(initCrop)
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (img.complete && img.naturalWidth > 0) {
          syncCanvasSize()
          initCrop()
        }
      })
      ro.observe(frame)
      ro.observe(img)
    }
  })

  onCleanup(() => {
    ro?.disconnect()
  })

  const onDown = (e: PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    setStartPos(getCoords(e))
    canvas.setPointerCapture(e.pointerId)
  }

  const onMove = (e: PointerEvent) => {
    if (!dragging()) return
    const pos = getCoords(e)
    const start = startPos()
    const w = canvas.width
    const h = canvas.height

    const x1 = Math.max(0, Math.min(start.x, pos.x))
    const y1 = Math.max(0, Math.min(start.y, pos.y))
    const x2 = Math.min(w, Math.max(start.x, pos.x))
    const y2 = Math.min(h, Math.max(start.y, pos.y))

    setCrop({ x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) })
    drawOverlay()
  }

  const onUp = (e: PointerEvent) => {
    if (!dragging()) return
    setDragging(false)
    canvas.releasePointerCapture(e.pointerId)
  }

  const onSave = () => {
    const box = crop()
    if (!box || box.w < 1 || box.h < 1) {
      props.onSave(canvas.toDataURL("image/png"))
      return
    }

    const scaleX = img.naturalWidth / canvas.width
    const scaleY = img.naturalHeight / canvas.height
    const srcX = box.x * scaleX
    const srcY = box.y * scaleY
    const srcW = box.w * scaleX
    const srcH = box.h * scaleY

    const c = document.createElement("canvas")
    c.width = Math.round(srcW)
    c.height = Math.round(srcH)
    const ctx = c.getContext("2d")!
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, c.width, c.height)
    props.onSave(c.toDataURL("image/png"))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      props.onCancel()
    }
  }

  return (
    <div
      data-component="image-crop-editor"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t("ui.imageCropEditor.title")}
    >
      <div data-slot="image-draw-editor-header">
        <div data-slot="image-draw-editor-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 1V12H15M1 4H12V15"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {i18n.t("ui.imageCropEditor.title")}
        </div>

        <div data-slot="image-draw-editor-header-actions">
          <button type="button" data-slot="image-draw-editor-btn" data-action="cancel" onClick={props.onCancel}>
            {i18n.t("ui.imageCropEditor.cancel")}
          </button>
          <button type="button" data-slot="image-draw-editor-btn" data-action="save" onClick={onSave}>
            {i18n.t("ui.imageCropEditor.save")}
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
    </div>
  )
}
