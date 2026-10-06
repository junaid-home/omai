import type { RGBA } from "@opentui/core"
import { createSignal, onCleanup, onMount, type JSX } from "solid-js"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { color?: RGBA; children?: JSX.Element }) {
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setFrame((index) => (index + 1) % SPINNER_FRAMES.length), 80)
    timer.unref()
    onCleanup(() => clearInterval(timer))
  })
  return (
    <text fg={props.color}>
      {SPINNER_FRAMES[frame()]}
      {props.children ? " " : ""}
      {props.children}
    </text>
  )
}
