import { Show } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { isVisualEditorEnabled, toggleVisualEditor } from "@/context/visual-editor"

export function VisualEditorToggle() {
  return (
    <TooltipV2 value={isVisualEditorEnabled() ? "Disable visual editor" : "Enable visual editor"} placement="bottom">
      <div class="relative">
        <IconButtonV2
          icon={<Icon name="edit" size="small" />}
          variant="ghost-muted"
          size="large"
          onClick={toggleVisualEditor}
          aria-label="Toggle visual editor"
          classList={{ "bg-[var(--v2-overlay-simple-overlay-hover)]!": isVisualEditorEnabled() }}
        />
        <Show when={isVisualEditorEnabled()}>
          <span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
        </Show>
      </div>
    </TooltipV2>
  )
}
