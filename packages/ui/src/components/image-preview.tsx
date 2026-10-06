import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { useI18n } from "../context/i18n"
import { useDialog } from "../context/dialog"
import { IconButton } from "./icon-button"
import { ImageDrawEditor } from "./image-draw-editor"
import { ImageRotateEditor } from "./image-rotate-editor"
import { ImageCropEditor } from "./image-crop-editor"
import { showToastV2 } from "../v2/components/toast-v2"

export interface GalleryImage {
  src: string
  alt?: string
}

export interface ImagePreviewProps {
  src: string
  alt?: string
  mime?: string
  images?: GalleryImage[]
  initialIndex?: number
  editable?: boolean
  onSave?: (dataUrl: string) => void
}

type EditorMode = "draw" | "rotate" | "crop" | null

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const dialog = useDialog()
  const isVideo = () => !!props.mime?.startsWith("video/")
  const [index, setIndex] = createSignal(props.initialIndex ?? 0)
  const [edited, setEdited] = createSignal<string | undefined>()
  const [editorMode, setEditorMode] = createSignal<EditorMode>(null)

  let bodyEl!: HTMLDivElement
  let mediaEl!: HTMLImageElement | HTMLVideoElement
  const [zoomLevel, setZoomLevel] = createSignal(1)
  const [panOffset, setPanOffset] = createSignal({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = createSignal(false)
  let panStart = { x: 0, y: 0 }
  let panOffsetStart = { x: 0, y: 0 }

  const clampPan = (px: number, py: number, zoom: number) => {
    const img = mediaEl
    const container = bodyEl
    if (!img || !container) return { x: px, y: py }
    const imgW = (img.getBoundingClientRect().width / zoomLevel()) * zoom
    const imgH = (img.getBoundingClientRect().height / zoomLevel()) * zoom
    const cW = container.clientWidth
    const cH = container.clientHeight
    const maxX = Math.max(0, (imgW - cW) / 2)
    const maxY = Math.max(0, (imgH - cH) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, px)),
      y: Math.min(maxY, Math.max(-maxY, py)),
    }
  }

  const zoomToPoint = (newZoom: number, clientX: number, clientY: number) => {
    const container = bodyEl
    if (!container) return
    const clamped = Math.min(Math.max(newZoom, 1), 4)
    if (clamped === 1) {
      setPanOffset({ x: 0, y: 0 })
      setZoomLevel(1)
      return
    }
    const rect = container.getBoundingClientRect()
    const mouseX = clientX - rect.left - rect.width / 2
    const mouseY = clientY - rect.top - rect.height / 2
    const ratio = clamped / zoomLevel()
    setPanOffset((prev) => {
      const rawX = mouseX - ratio * (mouseX - prev.x)
      const rawY = mouseY - ratio * (mouseY - prev.y)
      return clampPan(rawX, rawY, clamped)
    })
    setZoomLevel(clamped)
  }

  const resetZoom = () => {
    setZoomLevel(1)
    setPanOffset({ x: 0, y: 0 })
  }

  const onWheel = (e: WheelEvent) => {
    if (editorMode()) return
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.85 : 1.18
    zoomToPoint(zoomLevel() * factor, e.clientX, e.clientY)
  }

  const onDoubleClick = (e: MouseEvent) => {
    if (editorMode()) return
    e.preventDefault()
    if (zoomLevel() > 1.5) {
      resetZoom()
    } else {
      zoomToPoint(3, e.clientX, e.clientY)
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (editorMode() || zoomLevel() <= 1) return
    e.preventDefault()
    setIsPanning(true)
    panStart = { x: e.clientX, y: e.clientY }
    panOffsetStart = { ...panOffset() }
    bodyEl.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!isPanning()) return
    const dx = e.clientX - panStart.x
    const dy = e.clientY - panStart.y
    setPanOffset(clampPan(panOffsetStart.x + dx, panOffsetStart.y + dy, zoomLevel()))
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!isPanning()) return
    setIsPanning(false)
    bodyEl.releasePointerCapture(e.pointerId)
  }

  onMount(() => {
    bodyEl.addEventListener("wheel", onWheel, { passive: false })
  })

  onCleanup(() => {
    bodyEl?.removeEventListener("wheel", onWheel)
  })

  const gallery = createMemo(() => {
    if (props.images && props.images.length > 0) return props.images
    if (!props.src) return []
    return [{ src: props.src, alt: props.alt }]
  })

  const count = () => gallery().length
  const hasGallery = () => count() > 1
  const current = createMemo(() => gallery()[index()] ?? gallery()[0])

  const navigate = (delta: number) => {
    const n = count()
    if (!n) return
    setEdited(undefined)
    setEditorMode(null)
    setIndex((prev) => (prev + delta + n) % n)
  }

  const displayedSrc = () => edited() ?? current().src
  const displayedAlt = () => current().alt

  return (
    <div
      data-component="image-preview"
      onKeyDown={(e) => {
        if (editorMode()) return
        if (hasGallery() && e.key === "ArrowLeft") {
          e.preventDefault()
          navigate(-1)
        }
        if (hasGallery() && e.key === "ArrowRight") {
          e.preventDefault()
          navigate(1)
        }
      }}
    >
      <Kobalte.Content data-slot="image-preview-content">
        <Show
          when={!editorMode()}
          fallback={
            <div data-slot="image-preview-editor">
              <Show when={editorMode() === "draw"}>
                <ImageDrawEditor
                  src={displayedSrc()}
                  onCancel={() => setEditorMode(null)}
                  onSave={(dataUrl) => {
                    setEditorMode(null)
                    setEdited(dataUrl)
                    if (props.onSave) {
                      props.onSave(dataUrl)
                    } else {
                      dialog.save(dataUrl)
                    }
                    dialog.close()
                  }}
                />
              </Show>
              <Show when={editorMode() === "rotate"}>
                <ImageRotateEditor
                  src={displayedSrc()}
                  onCancel={() => setEditorMode(null)}
                  onSave={(dataUrl) => {
                    setEditorMode(null)
                    setEdited(dataUrl)
                    if (props.onSave) {
                      props.onSave(dataUrl)
                    } else {
                      dialog.save(dataUrl)
                    }
                    dialog.close()
                  }}
                />
              </Show>
              <Show when={editorMode() === "crop"}>
                <ImageCropEditor
                  src={displayedSrc()}
                  onCancel={() => setEditorMode(null)}
                  onSave={(dataUrl) => {
                    setEditorMode(null)
                    setEdited(dataUrl)
                    if (props.onSave) {
                      props.onSave(dataUrl)
                    } else {
                      dialog.save(dataUrl)
                    }
                    dialog.close()
                  }}
                />
              </Show>
            </div>
          }
        >
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-title">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="13" height="13" rx="3" stroke="currentColor" stroke-width="1.4" />
                <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
                <path
                  d="M1.5 11L5 7.5L8 10.5L10.5 8L14.5 12.5"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {i18n.t("ui.imagePreview.title")}
            </div>
            <div data-slot="image-preview-header-actions">
              <Show when={!isVideo() && props.editable}>
                <button type="button" data-slot="image-preview-draw" onClick={() => setEditorMode("draw")}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M13.5555 8.2153V13.5556H2.4444V2.4445H7.7846M6.8889 9.1111C6.8889 9.1111 8.9634 9.0366 9.6969 8.3031L14.0302 3.9699C14.5825 3.4176 14.5825 2.5221 14.0302 1.9699C13.4779 1.4176 12.5824 1.4176 12.0301 1.9699L7.6969 6.3031C7.0052 6.9948 6.8889 9.1111 6.8889 9.1111Z"
                      stroke="currentColor"
                    />
                  </svg>
                  {i18n.t("ui.imagePreview.draw")}
                </button>
                <button type="button" data-slot="image-preview-draw" onClick={() => setEditorMode("rotate")}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14"
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
                  {i18n.t("ui.imagePreview.rotate")}
                </button>
                <button type="button" data-slot="image-preview-draw" onClick={() => setEditorMode("crop")}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M4 1V12H15M1 4H12V15"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {i18n.t("ui.imagePreview.crop")}
                </button>
              </Show>
              <Show when={!isVideo()}>
                <button
                  type="button"
                  data-slot="image-preview-draw"
                  onClick={async () => {
                    try {
                      const response = await fetch(displayedSrc())
                      const blob = await response.blob()
                      const url = URL.createObjectURL(blob)
                      const link = document.createElement("a")
                      link.href = url
                      link.download = displayedAlt() || "image.png"
                      link.click()
                      URL.revokeObjectURL(url)
                    } catch (err) {
                      console.error("Failed to download image:", err)
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M8 2V10M8 10L5 7M8 10L11 7"
                      stroke="currentColor"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M2 12V13C2 13.5523 2.44772 14 3 14H13C13.5523 14 14 13.5523 14 13V12"
                      stroke="currentColor"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {i18n.t("ui.imagePreview.download")}
                </button>
              </Show>
              <Show when={!isVideo()}>
                <button
                  type="button"
                  data-slot="image-preview-draw"
                  onClick={async () => {
                    try {
                      const response = await fetch(displayedSrc())
                      const blob = await response.blob()
                      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
                      showToastV2(i18n.t("ui.imagePreview.copied"))
                    } catch (err) {
                      console.error("Failed to copy image:", err)
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4" />
                    <path
                      d="M11 5V3.5C11 2.67157 10.3284 2 9.5 2H3.5C2.67157 2 2 2.67157 2 3.5V9.5C2 10.3284 2.67157 11 3.5 11H5"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                  </svg>
                  {i18n.t("ui.imagePreview.copy")}
                </button>
              </Show>
              <Kobalte.CloseButton
                data-slot="image-preview-close"
                as={IconButton}
                icon="close"
                variant="ghost"
                aria-label={i18n.t("ui.common.close")}
              />
            </div>
          </div>

          <div
            data-slot="image-preview-body"
            ref={bodyEl}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDblClick={onDoubleClick}
            style={{ cursor: zoomLevel() > 1 ? (isPanning() ? "grabbing" : "grab") : undefined }}
          >
            <Show when={hasGallery()}>
              <button
                type="button"
                data-slot="image-preview-nav"
                data-direction="left"
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(-1)
                }}
                aria-label={i18n.t("ui.imagePreview.previous")}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M10 3L5 8L10 13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </Show>

            <Show
              when={!isVideo()}
              fallback={
                <video
                  ref={mediaEl as HTMLVideoElement}
                  src={displayedSrc()}
                  data-slot="image-preview-image"
                  controls
                  autoplay
                  loop
                  muted
                  style={{
                    transform: `translate(${panOffset().x}px, ${panOffset().y}px) scale(${zoomLevel()})`,
                    transition: isPanning() ? "none" : "transform 0.15s ease-out",
                  }}
                />
              }
            >
              <img
                ref={mediaEl as HTMLImageElement}
                src={displayedSrc()}
                alt={displayedAlt() ?? i18n.t("ui.imagePreview.alt")}
                data-slot="image-preview-image"
                draggable={false}
                style={{
                  transform: `translate(${panOffset().x}px, ${panOffset().y}px) scale(${zoomLevel()})`,
                  transition: isPanning() ? "none" : "transform 0.15s ease-out",
                }}
              />
            </Show>

            <Show when={hasGallery()}>
              <button
                type="button"
                data-slot="image-preview-nav"
                data-direction="right"
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(1)
                }}
                aria-label={i18n.t("ui.imagePreview.next")}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </Show>
          </div>

          <Show when={!isVideo() && !editorMode()}>
            <div
              data-slot="image-preview-zoombar"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                data-slot="image-preview-zoom-btn"
                title={i18n.t("ui.imagePreview.zoomOut")}
                onClick={(e) => {
                  e.stopPropagation()
                  const r = bodyEl.getBoundingClientRect()
                  zoomToPoint(zoomLevel() * 0.7, r.left + r.width / 2, r.top + r.height / 2)
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              </button>

              <div data-slot="image-preview-zoom-presets">
                {[1, 2, 4].map((level) => (
                  <button
                    type="button"
                    data-slot="image-preview-zoom-preset"
                    data-active={Math.abs(zoomLevel() - level) < 0.2 ? "" : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = bodyEl.getBoundingClientRect()
                      zoomToPoint(level, r.left + r.width / 2, r.top + r.height / 2)
                    }}
                  >
                    {level === 1 ? i18n.t("ui.imagePreview.fit") : `${level}x`}
                  </button>
                ))}
              </div>

              <div data-slot="image-preview-zoom-separator" />

              <span data-slot="image-preview-zoom-percent">{Math.round(zoomLevel() * 100)}%</span>

              <div data-slot="image-preview-zoom-separator" />

              <button
                type="button"
                data-slot="image-preview-zoom-btn"
                title={i18n.t("ui.imagePreview.zoomIn")}
                onClick={(e) => {
                  e.stopPropagation()
                  const r = bodyEl.getBoundingClientRect()
                  zoomToPoint(zoomLevel() * 1.4, r.left + r.width / 2, r.top + r.height / 2)
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="11" y1="8" x2="11" y2="14" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              </button>

              <button
                type="button"
                data-slot="image-preview-zoom-btn"
                title={i18n.t("ui.imagePreview.reset")}
                onClick={(e) => {
                  e.stopPropagation()
                  resetZoom()
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </div>
          </Show>
        </Show>
      </Kobalte.Content>
    </div>
  )
}
