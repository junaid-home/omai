import { Show, createEffect, createSignal, For, on, batch, onMount, onCleanup } from "solid-js"
import { useVisualEditor } from "@/context/visual-editor"
import type { ComputedStyles } from "@/context/visual-editor"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function imageMime(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
  }
  return map[ext] ?? "image/png"
}

function StyleInput(props: {
  label: string
  value: string
  onInput: (v: string) => void
  onBlur?: () => void
  class?: string
}) {
  return (
    <div class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <span
        class="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--v2-text-text-muted, #666)" }}
      >
        {props.label}
      </span>
      <input
        type="text"
        class="w-full rounded border px-1.5 py-1 text-[11px] outline-none transition-colors"
        style={{
          background: "var(--v2-background-bg-base, #fff)",
          "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
          color: "var(--v2-text-text-base)",
        }}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={() => props.onBlur?.()}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}

function SelectInput(props: {
  label: string
  value: string
  options: { label: string; value: string }[]
  onChange: (v: string) => void
  onBlur?: () => void
  class?: string
  showCurrent?: boolean
}) {
  const matched = () => props.options.some((o) => o.value.toLowerCase().trim() === props.value.toLowerCase().trim())
  return (
    <div class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <span
        class="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--v2-text-text-muted, #666)" }}
      >
        {props.label}
      </span>
      <select
        class="w-full rounded border px-1 py-1 text-[11px] outline-none cursor-pointer"
        style={{
          background: "var(--v2-background-bg-base, #fff)",
          "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
          color: "var(--v2-text-text-base)",
        }}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        onBlur={() => props.onBlur?.()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Show when={props.showCurrent && props.value !== "" && !matched()}>
          <option value={props.value} disabled>
            {props.value}
          </option>
        </Show>
        <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
    </div>
  )
}

function AlignButton(props: { value: string; current: string; onInput: (v: string) => void }) {
  const active = () => props.current === props.value
  return (
    <button
      type="button"
      class="flex items-center justify-center w-6 h-6 rounded cursor-pointer border-0 transition-colors"
      style={{
        background: active() ? "var(--v2-overlay-simple-overlay-hover, rgba(0,0,0,0.08))" : "transparent",
        color: active() ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted, #666)",
      }}
      onClick={() => props.onInput(props.value)}
    >
      <svg viewBox="0 0 12 12" fill="none" class="size-3">
        {props.value === "left" && (
          <path d="M1 2h10M1 5h7M1 8h10M1 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        )}
        {props.value === "center" && (
          <path d="M1 2h10M2.5 5h7M1 8h10M4 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        )}
        {props.value === "right" && (
          <path d="M1 2h10M5 5h7M1 8h10M8 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        )}
        {props.value === "justify" && (
          <path d="M1 2h10M1 5h10M1 8h10M1 11h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        )}
      </svg>
    </button>
  )
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "System UI", value: "system-ui, -apple-system, sans-serif" },
  { label: "Segoe UI", value: "Segoe UI, system-ui, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Helvetica", value: "Helvetica Neue, Helvetica, Arial, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, Tahoma, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, Verdana, sans-serif" },
  { label: "Trebuchet MS", value: "Trebuchet MS, sans-serif" },
  { label: "Impact", value: "Impact, Haettenschweiler, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, Cambria, 'Times New Roman', Times, serif" },
  { label: "Times New Roman", value: "Times New Roman, Times, serif" },
  { label: "Palatino", value: "Palatino Linotype, Palatino, 'Book Antiqua', serif" },
  { label: "Courier New", value: "Courier New, Courier, monospace" },
  { label: "Consolas", value: "Consolas, Menlo, monospace" },
]

const WEIGHT_PRESETS = [
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "SemiBold", value: "600" },
  { label: "Bold", value: "700" },
  { label: "Black", value: "900" },
]

const STYLE_OPTIONS = [
  { label: "Normal", value: "normal" },
  { label: "Italic", value: "italic" },
]

function weightSelectValue(current: string | undefined): string {
  const aliases: Record<string, string> = { normal: "400", bold: "700", bolder: "700", lighter: "300" }
  return current ? (aliases[current.toLowerCase()] ?? current) : ""
}

function SpacingInput(props: {
  label: string
  top: string
  right: string
  bottom: string
  left: string
  onChange: (side: "top" | "right" | "bottom" | "left", value: string) => void
  onBlur?: () => void
}) {
  const inputClass = "w-full rounded border px-1 py-0.5 text-[10px] outline-none text-center"
  const inputStyle = {
    background: "var(--v2-background-bg-base, #fff)",
    "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
    color: "var(--v2-text-text-base)",
  }
  return (
    <div class="flex flex-col gap-0.5">
      <span
        class="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--v2-text-text-muted, #666)" }}
      >
        {props.label}
      </span>
      <div class="grid grid-cols-4 gap-1">
        <input
          type="text"
          class={inputClass}
          style={inputStyle}
          placeholder="T"
          value={props.top}
          onInput={(e) => props.onChange("top", e.currentTarget.value)}
          onBlur={() => props.onBlur?.()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <input
          type="text"
          class={inputClass}
          style={inputStyle}
          placeholder="R"
          value={props.right}
          onInput={(e) => props.onChange("right", e.currentTarget.value)}
          onBlur={() => props.onBlur?.()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <input
          type="text"
          class={inputClass}
          style={inputStyle}
          placeholder="B"
          value={props.bottom}
          onInput={(e) => props.onChange("bottom", e.currentTarget.value)}
          onBlur={() => props.onBlur?.()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <input
          type="text"
          class={inputClass}
          style={inputStyle}
          placeholder="L"
          value={props.left}
          onInput={(e) => props.onChange("left", e.currentTarget.value)}
          onBlur={() => props.onBlur?.()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  )
}

export function VisualEditorPanel() {
  const editor = useVisualEditor()
  const sdk = useSDK()
  const local = useLocal()
  const [textValue, setTextValue] = createSignal("")
  const [tagDisplay, setTagDisplay] = createSignal("")
  const [attrList, setAttrList] = createSignal<[string, string][]>([])
  const [sourceInfo, setSourceInfo] = createSignal<{ path: string; line: number; column: number } | null>(null)
  const [styles, setStyles] = createSignal<ComputedStyles>({} as ComputedStyles)
  const [saving, setSaving] = createSignal(false)
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null)
  const [imageUrl, setImageUrl] = createSignal("")
  const [altValue, setAltValue] = createSignal("")
  const [uploading, setUploading] = createSignal(false)
  const [uploadError, setUploadError] = createSignal("")
  let textareaRef: HTMLTextAreaElement | undefined
  let imageInputRef: HTMLInputElement | undefined

  createEffect(
    on(
      () => editor.selectedElement(),
      (el) => {
        if (!el) {
          setSourceInfo(null)
          return
        }
        setTextValue(el.textContent)
        setTagDisplay(el.tagName)
        setStyles(el.computedStyles)
        setImageUrl(el.imageSrc ?? "")
        setAltValue(el.imageKind === "img" ? (el.imageAlt ?? "") : "")
        setAttrList(
          Object.entries(el.attributes).filter(
            ([key]) => key !== "style" && !key.startsWith("data-ve-") && !key.startsWith("data-insp-"),
          ),
        )
        if (el.sourcePath) {
          setSourceInfo({ path: el.sourcePath, line: el.sourceLine ?? 0, column: el.sourceColumn ?? 0 })
        } else {
          setSourceInfo(null)
        }
      },
    ),
  )

  onMount(() => {
    const onQuickReplace = () => imageInputRef?.click()
    window.addEventListener("ve-request-image-replace", onQuickReplace)
    onCleanup(() => window.removeEventListener("ve-request-image-replace", onQuickReplace))
  })

  const handleImageFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const base64 = bytesToBase64(bytes)
    setUploading(true)
    setUploadError("")
    try {
      const result = await sdk().client.file.upload({ fileName: file.name, content: base64 })
      const data = result.data as { url?: string } | undefined
      if (data?.url) {
        const mime = file.type || imageMime(file.name)
        editor.replaceImageSource(`data:${mime};base64,${base64}`, data.url)
        setImageUrl(data.url)
      } else {
        setUploadError("Upload failed")
      }
    } catch (err) {
      setUploadError("Upload failed")
      console.error("Image upload failed:", err)
    } finally {
      setUploading(false)
      if (imageInputRef) imageInputRef.value = ""
    }
  }

  const handleImageUrlApply = () => {
    const src = imageUrl().trim()
    if (!src) return
    editor.replaceImageSource(src)
  }

  createEffect(
    on(
      () => editor.isEditing(),
      (editing) => {
        if (editing && !editor.inlineEditing() && textareaRef) {
          requestAnimationFrame(() => {
            textareaRef?.focus()
            textareaRef?.select()
          })
        }
      },
    ),
  )

  const handleApply = () => {
    editor.stopEditing(textValue())
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleApply()
    }
    if (e.key === "Escape") {
      editor.cancelEditing()
    }
  }

  const applyProp = (prop: string, value: string) => {
    editor.applyCssProperty(prop, value)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMessage(null)
    try {
      const html = await editor.collectModifiedHtml()
      if (!html) return
      // Apply with the model the chat uses (an admin-assigned one included).
      const model = local.model.current()
      const result = await sdk().client.file.visualEdit({
        modifiedHtml: html,
        changes: editor.pendingChanges(),
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
      })
      const filesWritten = result.data?.filesWritten ?? []
      if (filesWritten.length > 0) {
        editor.clearChanges()
        setSaveMessage(`Saved to ${filesWritten.length} file${filesWritten.length > 1 ? "s" : ""}`)
      } else {
        setSaveMessage(`Failed to write files — ${result.data?.error ?? "the model did not respond"}`)
      }
      setTimeout(() => setSaveMessage(null), 4000)
    } catch (err) {
      setSaveMessage("Save failed")
      console.error("Visual editor save failed:", err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show when={editor.enabled() && editor.selectedElement()}>
      <div class="flex flex-col h-full overflow-y-auto" style={{ "scrollbar-width": "thin" }}>
        <div class="flex-1 p-3 space-y-3">
          {/* Image (shown instead of text content for image-like elements) */}
          <Show when={editor.selectedElement()?.isImage}>
            <div
              class="rounded-md border overflow-hidden"
              style={{ "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))" }}
            >
              <div
                class="flex items-center gap-2 px-2 py-1.5"
                style={{ background: "var(--v2-overlay-simple-overlay-hover, rgba(0,0,0,0.04))" }}
              >
                <span
                  class="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--v2-text-text-muted, #666)" }}
                >
                  Image
                </span>
                <span
                  class="truncate text-[10px] font-mono opacity-60"
                  style={{ color: "var(--v2-text-text-base)" }}
                  title={editor.selectedElement()?.imageSrc}
                >
                  {editor.selectedElement()?.imageKind === "svg"
                    ? "inline svg icon"
                    : editor.selectedElement()?.imageSrc || "no source"}
                </span>
              </div>
              <div class="flex items-start gap-2.5 p-2">
                <div
                  class="shrink-0 size-16 rounded border flex items-center justify-center overflow-hidden"
                  style={{
                    "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                    background: "rgba(0,0,0,0.04)",
                  }}
                >
                  <Show
                    when={editor.selectedElement()?.imageKind === "svg"}
                    fallback={
                      <img
                        src={editor.selectedElement()?.imagePreview}
                        alt=""
                        class="max-h-full max-w-full object-contain"
                      />
                    }
                  >
                    <img
                      src={`data:image/svg+xml,${encodeURIComponent(editor.selectedElement()?.imageSvg ?? "")}`}
                      alt="Selected icon"
                      class="max-h-full max-w-full"
                    />
                  </Show>
                </div>
                <div class="flex-1 min-w-0">
                  <span
                    class="block text-[10px] font-medium uppercase tracking-wider"
                    style={{ color: "var(--v2-text-text-muted, #666)" }}
                  >
                    {editor.selectedElement()?.imageKind === "svg" ? "Replace icon" : "Replace image"}
                  </span>
                  <span
                    class="block text-[10px] opacity-50 truncate mt-0.5"
                    style={{ color: "var(--v2-text-text-base)" }}
                  >
                    Paste a URL or upload a logo, image, icon or SVG
                  </span>
                  <div class="flex items-center gap-1 mt-1.5">
                    <input
                      type="text"
                      class="flex-1 min-w-0 rounded border px-1.5 py-1 text-[11px] outline-none"
                      style={{
                        background: "var(--v2-background-bg-base, #fff)",
                        "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                        color: "var(--v2-text-text-base)",
                      }}
                      placeholder="https://… or /path/to/logo.svg"
                      value={imageUrl()}
                      onInput={(e) => setImageUrl(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === "Enter") {
                          e.preventDefault()
                          handleImageUrlApply()
                        }
                        if (e.key === "Escape") {
                          e.preventDefault()
                          e.currentTarget.blur()
                        }
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      class="shrink-0 text-[10px] font-medium px-2 py-1 rounded cursor-pointer border-0 text-white"
                      style={{ background: "var(--v2-accent-base, #0a4a8a)", opacity: imageUrl().trim() ? "1" : "0.5" }}
                      disabled={!imageUrl().trim()}
                      onClick={handleImageUrlApply}
                    >
                      Apply
                    </button>
                  </div>
                  <div class="flex items-center gap-1.5 mt-1.5">
                    <button
                      type="button"
                      class="text-[10px] font-medium px-2.5 py-1 rounded-md cursor-pointer border-0 flex items-center gap-1 text-white"
                      style={{ background: "#16a34a" }}
                      disabled={uploading()}
                      onClick={() => imageInputRef?.click()}
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
                      {uploading() ? "Uploading…" : "Upload"}
                    </button>
                    <Show when={uploadError()}>
                      <span class="text-[10px]" style={{ color: "#dc2626" }}>
                        {uploadError()}
                      </span>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
            <Show when={editor.selectedElement()?.imageKind === "img"}>
              <div>
                <span
                  class="text-[10px] font-medium uppercase tracking-wider block mb-0.5"
                  style={{ color: "var(--v2-text-text-muted, #666)" }}
                >
                  Alt Text
                </span>
                <input
                  type="text"
                  class="w-full rounded border px-1.5 py-1 text-[11px] outline-none"
                  style={{
                    background: "var(--v2-background-bg-base, #fff)",
                    "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                    color: "var(--v2-text-text-base)",
                  }}
                  value={altValue()}
                  onInput={(e) => {
                    const v = e.currentTarget.value
                    setAltValue(v)
                    editor.applyAttribute("alt", v)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              </div>
            </Show>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif,image/x-icon,image/bmp"
              class="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                if (file) void handleImageFile(file)
              }}
            />
          </Show>

          {/* Text Content */}
          <Show when={!editor.selectedElement()?.isImage}>
            <div>
              <label
                class="text-[10px] font-medium uppercase tracking-wider block mb-1"
                style={{ color: "var(--v2-text-text-muted, #666)" }}
              >
                Text Content
              </label>
              <textarea
                ref={textareaRef}
                class="w-full resize-none rounded-md border px-2 py-1.5 text-[12px] outline-none transition-colors"
                style={{
                  background: "var(--v2-background-bg-base, #fff)",
                  "border-color": editor.isEditing()
                    ? "var(--v2-accent-base, #0a4a8a)"
                    : "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                  color: "var(--v2-text-text-base)",
                  "font-family": "ui-monospace, monospace",
                  "min-height": "48px",
                }}
                rows={2}
                value={textValue()}
                onInput={(e) => {
                  const val = e.currentTarget.value
                  setTextValue(val)
                  editor.recordTextChange(val)
                }}
                onKeyDown={handleKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                onFocus={() => {
                  if (!editor.isEditing()) editor.startEditing(editor.selectedElement()!)
                }}
              />
            </div>
          </Show>

          {/* Typography */}
          <div>
            <div
              class="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--v2-text-text-muted, #666)" }}
            >
              Typography
            </div>
            <SelectInput
              label="Font"
              class="mb-2"
              value={styles().fontFamily ?? ""}
              showCurrent
              options={FONT_OPTIONS}
              onChange={(v) => {
                applyProp("font-family", v)
                editor.refreshSelectedStyles()
              }}
            />
            <div class="grid grid-cols-2 gap-2">
              <StyleInput
                label="Font Size"
                value={styles().fontSize ?? ""}
                onInput={(v) => applyProp("font-size", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
              <StyleInput
                label="Line Height"
                value={styles().lineHeight ?? ""}
                onInput={(v) => applyProp("line-height", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
              <StyleInput
                label="Letter Spacing"
                value={styles().letterSpacing ?? ""}
                onInput={(v) => applyProp("letter-spacing", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
            </div>
            <div class="grid grid-cols-2 gap-2 mt-2">
              <SelectInput
                label="Weight"
                value={weightSelectValue(styles().fontWeight)}
                options={WEIGHT_PRESETS}
                onChange={(v) => {
                  applyProp("font-weight", v)
                  editor.refreshSelectedStyles()
                }}
              />
              <SelectInput
                label="Style"
                value={styles().fontStyle ?? ""}
                options={STYLE_OPTIONS}
                onChange={(v) => {
                  applyProp("font-style", v)
                  editor.refreshSelectedStyles()
                }}
              />
            </div>
            <div class="mt-2">
              <span
                class="text-[10px] font-medium uppercase tracking-wider block mb-1"
                style={{ color: "var(--v2-text-text-muted, #666)" }}
              >
                Align
              </span>
              <div class="flex gap-1">
                <AlignButton
                  value="left"
                  current={styles().textAlign ?? ""}
                  onInput={(v) => applyProp("text-align", v)}
                />
                <AlignButton
                  value="center"
                  current={styles().textAlign ?? ""}
                  onInput={(v) => applyProp("text-align", v)}
                />
                <AlignButton
                  value="right"
                  current={styles().textAlign ?? ""}
                  onInput={(v) => applyProp("text-align", v)}
                />
                <AlignButton
                  value="justify"
                  current={styles().textAlign ?? ""}
                  onInput={(v) => applyProp("text-align", v)}
                />
              </div>
            </div>
          </div>

          {/* Colors */}
          <div>
            <div
              class="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--v2-text-text-muted, #666)" }}
            >
              Colors
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-0.5">
                <span
                  class="text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: "var(--v2-text-text-muted, #666)" }}
                >
                  Text
                </span>
                <div class="flex items-center gap-1">
                  <input
                    type="color"
                    class="w-6 h-6 rounded border cursor-pointer p-0"
                    style={{ "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))" }}
                    value={styles().color ?? "#000000"}
                    onInput={(e) => applyProp("color", e.currentTarget.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                  <input
                    type="text"
                    class="flex-1 rounded border px-1.5 py-1 text-[11px] outline-none"
                    style={{
                      background: "var(--v2-background-bg-base, #fff)",
                      "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                      color: "var(--v2-text-text-base)",
                    }}
                    value={styles().color ?? ""}
                    onInput={(e) => applyProp("color", e.currentTarget.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
              <div class="flex flex-col gap-0.5">
                <span
                  class="text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: "var(--v2-text-text-muted, #666)" }}
                >
                  Background
                </span>
                <div class="flex items-center gap-1">
                  <input
                    type="color"
                    class="w-6 h-6 rounded border cursor-pointer p-0"
                    style={{ "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))" }}
                    value={styles().backgroundColor ?? "#ffffff"}
                    onInput={(e) => applyProp("background-color", e.currentTarget.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                  <input
                    type="text"
                    class="flex-1 rounded border px-1.5 py-1 text-[11px] outline-none"
                    style={{
                      background: "var(--v2-background-bg-base, #fff)",
                      "border-color": "var(--v2-border-border-base, rgba(0,0,0,0.08))",
                      color: "var(--v2-text-text-base)",
                    }}
                    value={styles().backgroundColor ?? ""}
                    onInput={(e) => applyProp("background-color", e.currentTarget.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
            </div>
            <div class="mt-2">
              <StyleInput
                label="Opacity"
                value={styles().opacity ?? ""}
                onInput={(v) => applyProp("opacity", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
            </div>
          </div>

          {/* Spacing */}
          <div>
            <div
              class="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--v2-text-text-muted, #666)" }}
            >
              Spacing
            </div>
            <div class="space-y-2">
              <SpacingInput
                label="Padding"
                top={styles().paddingTop ?? ""}
                right={styles().paddingRight ?? ""}
                bottom={styles().paddingBottom ?? ""}
                left={styles().paddingLeft ?? ""}
                onChange={(side, v) => applyProp(`padding-${side}`, v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
              <SpacingInput
                label="Margin"
                top={styles().marginTop ?? ""}
                right={styles().marginRight ?? ""}
                bottom={styles().marginBottom ?? ""}
                left={styles().marginLeft ?? ""}
                onChange={(side, v) => applyProp(`margin-${side}`, v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
            </div>
          </div>

          {/* Border */}
          <div>
            <div
              class="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--v2-text-text-muted, #666)" }}
            >
              Border
            </div>
            <div class="grid grid-cols-2 gap-2">
              <StyleInput
                label="Radius"
                value={styles().borderRadius ?? ""}
                onInput={(v) => applyProp("border-radius", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
              <StyleInput
                label="Border"
                value={styles().border ?? ""}
                onInput={(v) => applyProp("border", v)}
                onBlur={() => editor.refreshSelectedStyles()}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          class="sticky bottom-0 px-3 py-2 border-t flex items-center justify-between shrink-0"
          style={{
            background: "var(--v2-background-bg-base, #fff)",
            "border-color": "var(--v2-border-border-muted, rgba(0,0,0,0.05))",
          }}
        >
          <div class="flex items-center gap-2">
            <Show when={saveMessage()}>
              <span
                class="text-[10px]"
                style={{
                  color: saveMessage() === "Saved!" ? "#16a34a" : "#dc2626",
                }}
              >
                {saveMessage()}
              </span>
            </Show>
            <Show when={!saveMessage()}>
              <span class="text-[10px] opacity-40" style={{ color: "var(--v2-text-text-base)" }}>
                {editor.pendingChanges().length > 0
                  ? `${editor.pendingChanges().length} unsaved change${editor.pendingChanges().length > 1 ? "s" : ""}`
                  : "Enter to apply, Esc to cancel"}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="text-[10px] font-medium px-2.5 py-1 rounded-md cursor-pointer border-0 transition-colors text-white"
              style={{
                background: saving() ? "#94a3b8" : editor.pendingChanges().length > 0 ? "#16a34a" : "#a6a8aa",
                opacity: saving() ? "0.7" : "1",
              }}
              disabled={saving() || editor.pendingChanges().length === 0}
              onClick={handleSave}
            >
              {saving() ? "Saving changes..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
