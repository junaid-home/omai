import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RotationLock } from "../script/lib/rotation-lock"

test("rotation holds the deployment filesystem lock until the supervised holder closes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omai-rotation-lock-"))
  try {
    const first = await RotationLock.acquire(root)
    try {
      await expect(RotationLock.acquire(root)).rejects.toThrow("already owned")
      const contender = Bun.spawn(["flock", "--nonblock", path.join(root, ".runtime.lock"), "true"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await contender.exited).toBe(1)
    } finally {
      first.stdin.end()
      expect(await first.exited).toBe(0)
    }
    const second = await RotationLock.acquire(root)
    second.stdin.end()
    expect(await second.exited).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
