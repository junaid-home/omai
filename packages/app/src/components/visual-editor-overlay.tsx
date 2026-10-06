import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { requestImageReplace, useVisualEditor } from "@/context/visual-editor"

export function VisualEditorOverlay(props: { containerRef?: () => HTMLDivElement | null }) {
  const editor = useVisualEditor()
  const [selectedBounds, setSelectedBounds] = createSignal<DOMRect | null>(null)
  const [selectedTag, setSelectedTag] = createSignal("")

  const [containerRect, setContainerRect] = createSignal<DOMRect | null>(null)

  createEffect(() => {
    const el = props.containerRef?.()
    if (!el) return
    const update = () => setContainerRect(el.getBoundingClientRect())
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener("resize", update)
    const interval = setInterval(update, 200)
    const cleanup = () => {
      ro.disconnect()
      window.removeEventListener("resize", update)
      clearInterval(interval)
    }
    onCleanup(cleanup)
  })

  createEffect(
    on(
      () => editor.selectedElement(),
      (el) => {
        if (!el) {
          setSelectedBounds(null)
          setSelectedTag("")
          return
        }
        const cr = containerRect()
        const x = cr ? el.bounds.x - cr.x : el.bounds.x
        const y = cr ? el.bounds.y - cr.y : el.bounds.y
        setSelectedBounds(new DOMRect(x, y, el.bounds.width, el.bounds.height))
        setSelectedTag(el.tagName)
      },
    ),
  )

  return (
    <Show when={editor.enabled()}>
      <div class="pointer-events-none absolute inset-0 z-[999990] overflow-hidden">
        <Show when={selectedBounds()}>
          <div
            class="absolute rounded-[2px] transition-all duration-100"
            style={{
              left: `${selectedBounds()!.x}px`,
              top: `${selectedBounds()!.y}px`,
              width: `${selectedBounds()!.width}px`,
              height: `${selectedBounds()!.height}px`,
              border: "2px solid rgb(16,185,129)",
              background: "rgba(16,185,129,0.08)",
            }}
          >
            <span
              class="absolute -top-5 left-0 text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap leading-[18px]"
              style={{ background: "rgb(16,185,129)", color: "#fff" }}
            >
              {selectedTag()}
            </span>
            <Show when={editor.selectedElement()?.isImage}>
              <button
                type="button"
                class="absolute -top-7 left-10 pointer-events-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold cursor-pointer border-0 whitespace-nowrap"
                style={{ background: "rgb(16,185,129)", color: "#fff", "box-shadow": "0 1px 4px rgba(0,0,0,0.25)" }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  requestImageReplace()
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <svg viewBox="0 0 12 12" fill="none" class="size-3">
                  <path
                    d="M6 2v6M3.5 4.5 6 2l2.5 2.5M2 9.5h8"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                Replace Image
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
