import { createRoot } from "solid-js"
import { createVisualBridge } from "../src/utils/visual-bridge"

declare global {
  interface Window {
    editor: ReturnType<typeof createVisualBridge>
  }
}

createRoot(() => {
  const editor = createVisualBridge({ enabled: () => true, setEnabled: () => undefined, toggle: () => undefined })
  window.editor = editor
  editor.setIframeRef(document.querySelector("iframe"))
})
