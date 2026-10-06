import { describe, expect, test } from "bun:test"
import { lstat, mkdir, readFile, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { WorkspaceFile } from "../../src/server/workspace-file"
import { tmpdir } from "../fixture/fixture"

describe("central workspace file targets", () => {
  test("resolves existing and new paths only in the assigned workspace", async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(workspace, "existing.ts"), "source")
    expect(await WorkspaceFile.resolve(workspace, workspace, "existing.ts")).toBe(path.join(workspace, "existing.ts"))
    expect(await WorkspaceFile.resolve(workspace, workspace, "new/sub/file.ts")).toBe(
      path.join(workspace, "new/sub/file.ts"),
    )
    expect(await WorkspaceFile.resolve(workspace, workspace, ".", true)).toBe(workspace)
    await expect(WorkspaceFile.resolve(workspace, workspace, ".")).rejects.toThrow("workspace root")
    await expect(WorkspaceFile.resolve(workspace, workspace, "../other/file")).rejects.toThrow("outside")
    await expect(WorkspaceFile.resolve(workspace, tmp.path, "workspace/existing.ts")).rejects.toThrow("outside")
  })

  test("rejects directory and leaf symlinks that leave the assigned workspace", async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    const other = path.join(tmp.path, "other")
    await mkdir(workspace)
    await Bun.write(path.join(other, "secret"), "private")
    await symlink(other, path.join(workspace, "linked"))
    await symlink(path.join(other, "secret"), path.join(workspace, "leaf"))
    await symlink(path.join(other, "missing"), path.join(workspace, "broken"))
    await expect(WorkspaceFile.resolve(workspace, workspace, "linked/new/file")).rejects.toThrow("escapes")
    await expect(WorkspaceFile.resolve(workspace, workspace, "leaf")).rejects.toThrow("escapes")
    await expect(WorkspaceFile.resolve(workspace, workspace, "broken")).rejects.toThrow("symlink")
    await expect(WorkspaceFile.resolve(workspace, path.join(workspace, "linked"), "secret")).rejects.toThrow("escapes")
  })

  test("validates a safe symlink without changing remove into deleting its target", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "source.ts"), "source")
    await symlink("source.ts", path.join(tmp.path, "alias.ts"))
    const target = await WorkspaceFile.resolve(tmp.path, tmp.path, "alias.ts")
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    await rm(target)
    expect(await readFile(path.join(tmp.path, "source.ts"), "utf8")).toBe("source")
  })
})
