import path from "node:path"

/** Hold the deployment's kernel flock until stdin closes; unexpected exit is observable by the caller. */
export async function acquire(root: string) {
  const holder = Bun.spawn(
    ["flock", "--nonblock", path.join(root, ".runtime.lock"), "sh", "-c", 'printf "locked\\n"; cat >/dev/null'],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  )
  const reader = holder.stdout.getReader()
  const decoder = new TextDecoder()
  let handshake = ""
  while (!handshake.endsWith("\n") && handshake.length < 64) {
    const chunk = await reader.read()
    if (chunk.done) break
    handshake += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  if (handshake !== "locked\n") {
    holder.kill()
    await holder.exited
    throw new Error("The central filesystem is already owned or its runtime lock could not be acquired")
  }
  return holder
}

export * as RotationLock from "./rotation-lock"
