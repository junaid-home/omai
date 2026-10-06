import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { CentralStorage } from "../src/storage/central"

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "central-storage-")))
  const config: CentralStorage.Config = { root, id: "instance-one" }
  await fs.writeFile(path.join(root, CentralStorage.markerName), JSON.stringify({ version: 1, id: config.id }))
  await fs.mkdir(path.join(root, "workspaces"))
  const escaped = root.replace(/ /g, "\\040")
  return {
    config,
    mount: `42 1 0:99 / ${escaped} rw,relatime - ext4 /dev/volume rw\n`,
    [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }),
  }
}

describe("central storage", () => {
  test("requires explicit complete central configuration without a local fallback", () => {
    expect(CentralStorage.configure({})).toBeUndefined()
    expect(() => CentralStorage.configure({ OPENCODE_STORAGE_ROOT: "/srv/omai" })).toThrow()
    expect(() => CentralStorage.configure({ OPENCODE_STORAGE_MODE: "centrla" })).toThrow()
    expect(() => CentralStorage.configure({ OPENCODE_STORAGE_MODE: "central" })).toThrow()
    expect(() =>
      CentralStorage.configure({
        OPENCODE_STORAGE_MODE: "central",
        OPENCODE_STORAGE_ROOT: "/",
        OPENCODE_STORAGE_ID: "a",
      }),
    ).toThrow()
    expect(() =>
      CentralStorage.configure({
        OPENCODE_STORAGE_MODE: "central",
        OPENCODE_STORAGE_ROOT: "/srv/a",
        OPENCODE_STORAGE_ID: "../a",
      }),
    ).toThrow()
    expect(() =>
      CentralStorage.configure({
        OPENCODE_STORAGE_MODE: "central",
        OPENCODE_STORAGE_ROOT: "/srv/a",
        OPENCODE_STORAGE_ID: "a",
        OPENCODE_CONFIG_DIR: "/tmp/config",
      }),
    ).toThrow()
  })

  test("rejects an absent or read-only mount without creating storage directories", async () => {
    await using input = await fixture()
    await expect(CentralStorage.verify(input.config, "")).rejects.toThrow("not a mounted volume")
    await expect(
      CentralStorage.verify(input.config, input.mount.replace("rw,relatime", "ro,relatime")),
    ).rejects.toThrow("read-only")
    expect(await fs.readdir(input.config.root)).not.toContain("data")
  })

  test("verifies volume identity and refuses a replacement mount", async () => {
    await using input = await fixture()
    await CentralStorage.verify(input.config, input.mount)
    await expect(CentralStorage.verify(input.config, input.mount.replace(/^42 /, "43 "))).rejects.toThrow(
      "mount changed",
    )
    await fs.writeFile(
      path.join(input.config.root, CentralStorage.markerName),
      JSON.stringify({ version: 1, id: "other" }),
    )
    await expect(CentralStorage.verify(input.config, input.mount)).rejects.toThrow("identity does not match")
  })

  test("mount loss is unavailable even after successful verification", async () => {
    await using input = await fixture()
    await CentralStorage.verify(input.config, input.mount)
    await expect(CentralStorage.verify(input.config, "")).rejects.toThrow("not a mounted volume")
    await fs.unlink(path.join(input.config.root, CentralStorage.markerName))
    await expect(CentralStorage.verify(input.config, input.mount)).rejects.toThrow()
  })

  test("rejects a symlink identity marker", async () => {
    await using input = await fixture()
    const marker = path.join(input.config.root, CentralStorage.markerName)
    await fs.rename(marker, `${marker}.original`)
    await fs.symlink(`${marker}.original`, marker)
    await expect(CentralStorage.verify(input.config, input.mount)).rejects.toThrow()
  })

  test("resolves prospective nested paths without granting sibling or symlink escape", async () => {
    await using input = await fixture()
    const root = path.join(input.config.root, "workspaces")
    expect(await CentralStorage.resolveUnder(root, path.join(root, "one", "src", "new.ts"))).toBe(
      path.join(root, "one", "src", "new.ts"),
    )
    await expect(
      CentralStorage.resolveUnder(root, path.join(input.config.root, "workspaces-other", "x")),
    ).rejects.toThrow()
    await fs.symlink(input.config.root, path.join(root, "escape"))
    await expect(CentralStorage.resolveUnder(root, path.join(root, "escape", "new.txt"))).rejects.toThrow()
    await fs.symlink(path.join(input.config.root, "missing-outside"), path.join(root, "broken"))
    await expect(CentralStorage.resolveUnder(root, path.join(root, "broken", "new.txt"))).rejects.toThrow()
  })

  test("rejects a symlink workspace root and a regular-file ancestor", async () => {
    await using input = await fixture()
    const root = path.join(input.config.root, "workspaces")
    await fs.writeFile(path.join(root, "file"), "content")
    await expect(CentralStorage.resolveUnder(root, path.join(root, "file", "new.txt"))).rejects.toThrow()
    await fs.symlink(root, path.join(input.config.root, "alias"))
    await expect(
      CentralStorage.resolveUnder(
        path.join(input.config.root, "alias"),
        path.join(input.config.root, "alias", "new.txt"),
      ),
    ).rejects.toThrow()
  })

  test("parses escaped mount paths without accepting prefix matches", () => {
    expect(CentralStorage.mountedAt("/srv/my volume", "2 1 0:2 / /srv/my\\040volume rw - ext4 /dev/d rw\n")).toBe("2")
    expect(() => CentralStorage.mountedAt("/srv/my", "2 1 0:2 / /srv/my-volume rw - ext4 /dev/d rw\n")).toThrow()
  })
})
