import { createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js"
import { useI18n } from "../context/i18n"

export interface ImageRotateEditorProps {
  src: string
  onSave: (dataUrl: string) => void
  onCancel: () => void
}

const isRemote = (src: string) => src.startsWith("/file/") || /^https?:\/\//.test(src)

const cacheBust = (src: string) =>
  isRemote(src) ? `${src}${src.includes("?") ? "&" : "?"}__cb=${Math.random().toString(36).slice(2)}` : src

export function ImageRotateEditor(props: ImageRotateEditorProps) {
  const i18n = useI18n()
  let canvas!: HTMLCanvasElement
  let img!: HTMLImageElement
  let frame!: HTMLDivElement

  const [rotation, setRotation] = createSignal(0)
  const [flipH, setFlipH] = createSignal(false)
  const [flipV, setFlipV] = createSignal(false)

  const imgSrc = createMemo(() => cacheBust(props.src))

  const syncCanvasSize = () => {
    const nw = img.naturalWidth
    const nh = img.naturalHeight

    if (nw > 0 && nh > 0) {
      const rotated = rotation() % 180 !== 0
      const imgW = rotated ? nh : nw
      const imgH = rotated ? nw : nh
      const frameRect = frame.getBoundingClientRect()
      const fw = Math.max(1, frameRect.width)
      const fh = Math.max(1, frameRect.height)
      const imgAspect = imgW / imgH
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
      canvas.width = Math.max(imgW, w)
      canvas.height = Math.max(imgH, h)
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

    c.fillStyle = "#0f172a"
    c.fillRect(0, 0, w, h)
    c.save()

    const rad = (rotation() * Math.PI) / 180

    c.translate(w / 2, h / 2)
    c.rotate(rad)
    c.scale(flipH() ? -1 : 1, flipV() ? -1 : 1)
    c.drawImage(img, -w / 2, -h / 2, w, h)

    c.restore()
  }

  let ro: ResizeObserver | undefined

  onMount(() => {
    img.onload = () => drawImage()
    if (img.complete && img.naturalWidth > 0) drawImage()
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (img.complete && img.naturalWidth > 0) drawImage()
      })
      ro.observe(frame)
      ro.observe(img)
    }
  })

  onCleanup(() => {
    ro?.disconnect()
  })

  createEffect(() => {
    rotation()
    flipH()
    flipV()
    if (img.complete && img.naturalWidth > 0) drawImage()
  })

  const onSave = () => {
    props.onSave(canvas.toDataURL("image/png"))
  }

  const onRotateLeft = () => setRotation((r) => (r - 90 + 360) % 360)
  const onRotateRight = () => setRotation((r) => (r + 90) % 360)
  const onFlipH = () => setFlipH((f) => !f)
  const onFlipV = () => setFlipV((f) => !f)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      props.onCancel()
    }
  }

  return (
    <div
      data-component="image-rotate-editor"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t("ui.imageRotateEditor.title")}
    >
      <div data-slot="image-draw-editor-header">
        <div data-slot="image-draw-editor-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <path
              d="M5 8L2 11L-1 8"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              transform="translate(3, -3)"
            />
          </svg>
          {i18n.t("ui.imageRotateEditor.title")}
        </div>

        <div data-slot="image-draw-editor-tools">
          <button type="button" data-slot="image-draw-editor-btn" onClick={onRotateLeft}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
              <path
                d="M5 5L2 8L5 11"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {i18n.t("ui.imageRotateEditor.rotateLeft")}
          </button>
          <button type="button" data-slot="image-draw-editor-btn" onClick={onRotateRight}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
              <path
                d="M11 5L14 8L11 11"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {i18n.t("ui.imageRotateEditor.rotateRight")}
          </button>
          <button
            type="button"
            data-slot="image-draw-editor-btn"
            onClick={onFlipH}
            data-active={flipH() ? "" : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 8H14M2 8L6 4M2 8L6 12M14 8L10 4M14 8L10 12"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {i18n.t("ui.imageRotateEditor.flipH")}
          </button>
          <button
            type="button"
            data-slot="image-draw-editor-btn"
            onClick={onFlipV}
            data-active={flipV() ? "" : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 2V14M8 2L4 6M8 2L12 6M8 14L4 10M8 14L12 10"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {i18n.t("ui.imageRotateEditor.flipV")}
          </button>
        </div>

        <div data-slot="image-draw-editor-header-actions">
          <button type="button" data-slot="image-draw-editor-btn" data-action="cancel" onClick={props.onCancel}>
            {i18n.t("ui.imageRotateEditor.cancel")}
          </button>
          <button type="button" data-slot="image-draw-editor-btn" data-action="save" onClick={onSave}>
            {i18n.t("ui.imageRotateEditor.save")}
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
          <canvas ref={canvas} data-slot="image-draw-editor-canvas" />
        </div>
      </div>
    </div>
  )
}
