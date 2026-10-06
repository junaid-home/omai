import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink } from "node:fs/promises"
import path from "node:path"
import JSZip from "jszip"
import { ProjectArchive } from "../../src/server/project-archive"
import { tmpdir } from "../fixture/fixture"

async function archive(files: Record<string, string | Buffer>, modes: Record<string, number> = {}) {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(files)) {
    zip.file(name, data, { createFolders: false, unixPermissions: modes[name] ?? 0o100644 })
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" })
}

describe("project ZIP round trip", () => {
  test("keeps source directories, binary assets, modes, empty directories and safe symlinks", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "project")
    const destination = path.join(tmp.path, "restored")
    const files = {
      "bin/launch": "#!/bin/sh\nprintf 'zip-round-trip'\n",
      "packages/desktop/src/main.ts": "export const desktop = true\n",
      "build/tasks.ts": "export const build = true\n",
      "vendor/client.ts": "export const client = true\n",
      "dist/manifest.json": '{"entry":"app.js"}',
      "src/secrets.ts": "export const name = 'configuration'\n",
      ".env.example": "DATABASE_URL=replace-me\n",
      ".env.sample": "PORT=4096\n",
      ".yarn/patches/tool.patch": "patch content",
      "assets/public.pem": "public certificate fixture",
      "artifacts/out/render.png": Buffer.from([0, 255, 13, 10, 3]),
    }
    for (const [name, data] of Object.entries(files)) await Bun.write(path.join(source, name), data)
    for (const name of [
      ".git/config",
      "node_modules/tool/index.js",
      ".cache/work",
      ".yarn/cache/tool.zip",
      ".env",
      ".env.production",
      ".npmrc",
      "deploy/central/secrets/database-password",
      ".aws/credentials",
    ]) {
      await Bun.write(path.join(source, name), "private-or-cache")
    }
    await chmod(path.join(source, "bin/launch"), 0o755)
    await chmod(path.join(source, "build/tasks.ts"), 0o640)
    await mkdir(path.join(source, "empty"), { mode: 0o750 })
    await symlink("../../bin/launch", path.join(source, "packages/desktop/launch"))
    const data = await ProjectArchive.build(source)
    const zipped = await JSZip.loadAsync(data, { checkCRC32: true })
    expect(Object.values(zipped.files).filter((item) => !item.dir)).toHaveLength(Object.keys(files).length + 1)
    expect(zipped.file("project/packages/desktop/src/main.ts")).not.toBeNull()
    expect(zipped.file("project/bin/launch")?.unixPermissions).toBe(0o100755)
    expect(await ProjectArchive.extract(data, destination)).toBe(Object.keys(files).length + 1)
    for (const [name, data] of Object.entries(files)) {
      expect(await readFile(path.join(destination, name))).toEqual(Buffer.from(data))
    }
    expect((await stat(path.join(destination, "bin/launch"))).mode & 0o777).toBe(0o755)
    expect((await stat(path.join(destination, "build/tasks.ts"))).mode & 0o777).toBe(0o640)
    expect((await stat(path.join(destination, "empty"))).mode & 0o777).toBe(0o750)
    expect(await readlink(path.join(destination, "packages/desktop/launch"))).toBe("../../bin/launch")
    const process = Bun.spawn([path.join(destination, "packages/desktop/launch")], { stdout: "pipe", stderr: "pipe" })
    expect(await process.exited).toBe(0)
    expect(await new Response(process.stdout).text()).toBe("zip-round-trip")
  })

  test("does not strip a directory when the ZIP also contains a root file", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "restored")
    expect(
      await ProjectArchive.extract(
        await archive({ "project/src/main.ts": "main", "README.md": "readme", "__MACOSX/._metadata": "ignored" }),
        destination,
      ),
    ).toBe(2)
    expect(await readFile(path.join(destination, "project/src/main.ts"), "utf8")).toBe("main")
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("readme")
  })

  test("does not export an escaping or cyclic symlink silently", async () => {
    await using tmp = await tmpdir()
    await symlink("../outside", path.join(tmp.path, "link"))
    await expect(ProjectArchive.build(tmp.path)).rejects.toThrow("symlink")
  })
})

describe("project ZIP validation", () => {
  for (const name of [
    "../escape",
    "project/../../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a//b",
    "a/./b",
    "a\0b",
    "con",
    "folder/file:secret",
  ]) {
    test(`rejects unsafe path ${JSON.stringify(name)} before writing`, async () => {
      await using tmp = await tmpdir()
      const destination = path.join(tmp.path, "restored")
      await expect(ProjectArchive.extract(await archive({ [name]: "unsafe" }), destination)).rejects.toThrow(
        "Unsafe ZIP path",
      )
      expect(await readdir(tmp.path)).toEqual([])
    })
  }

  test("detects raw duplicate entries instead of keeping only the last one", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ "a.ts": "one", "b.ts": "two" })
    for (let index = data.indexOf("b.ts"); index !== -1; index = data.indexOf("b.ts", index + 4))
      data.write("a.ts", index)
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow("Duplicate ZIP path")
    expect(await readdir(tmp.path)).toEqual([])
  })

  const collisions: Record<string, string>[] = [
    { file: "file", "file/child": "child" },
    { "Folder/a": "one", "folder/b": "two" },
    { "caf\u00e9.txt": "one", "cafe\u0301.txt": "two" },
    { ".git/hooks/pre-commit": "#!/bin/sh\n" },
  ]
  for (const files of collisions) {
    test(`rejects conflicting paths ${Object.keys(files).join(", ")}`, async () => {
      await using tmp = await tmpdir()
      await expect(ProjectArchive.extract(await archive(files), path.join(tmp.path, "restored"))).rejects.toThrow()
      expect(await readdir(tmp.path)).toEqual([])
    })
  }

  test("rejects an entry below a symlink before creating it", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ link: "target", "link/file": "escape" }, { link: 0o120777 })
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow(
      "traverses a file or symlink",
    )
    expect(await readdir(tmp.path)).toEqual([])
  })

  for (const target of ["../outside", "/tmp/outside", "C:/outside", "folder\\outside"]) {
    test(`rejects unsafe symlink target ${target} without publishing partial files`, async () => {
      await using tmp = await tmpdir()
      const data = await archive({ "repo/main.ts": "main", "repo/link": target }, { "repo/link": 0o120777 })
      await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow("symlink")
      expect(await readdir(tmp.path)).toEqual([])
    })
  }

  test("resolves symlink chains before accepting dot-dot segments", async () => {
    await using tmp = await tmpdir()
    const data = await archive(
      { "repo/dir": ".", "repo/link": "dir/../outside" },
      { "repo/dir": 0o120777, "repo/link": 0o120777 },
    )
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow("symlink chain")
    expect(await readdir(tmp.path)).toEqual([])
  })

  test("rejects special Unix files", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ device: "" }, { device: 0o020666 })
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow(
      "Unsupported ZIP file type",
    )
  })

  test("does not replace existing project files or follow an existing destination symlink", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ "README.md": "new" })
    const destination = path.join(tmp.path, "existing")
    await Bun.write(path.join(destination, "README.md"), "keep")
    await symlink(destination, path.join(tmp.path, "link"))
    await expect(ProjectArchive.extract(data, destination)).rejects.toThrow("empty directory")
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "link"))).rejects.toThrow("empty directory")
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "link/new/deeper"))).rejects.toThrow("symlink")
    expect(await readdir(destination)).toEqual(["README.md"])
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("keep")
    expect((await lstat(path.join(tmp.path, "link"))).isSymbolicLink()).toBe(true)
  })

  test("checks the uncompressed size limit before creating the destination", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ "large.txt": "small" })
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    data.writeUInt32LE(ProjectArchive.limits.fileBytes + 1, central + 24)
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow("256 MiB")
    expect(await readdir(tmp.path)).toEqual([])
  })

  test("checks total expanded size before creating the destination", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ a: "a", b: "b", c: "c", d: "d", e: "e" })
    for (
      let index = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      index !== -1;
      index = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), index + 4)
    ) {
      data.writeUInt32LE(ProjectArchive.limits.fileBytes, index + 24)
    }
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow("1 GiB")
    expect(await readdir(tmp.path)).toEqual([])
  })

  test("stops actual expansion when a ZIP lies about its uncompressed size", async () => {
    await using tmp = await tmpdir()
    const data = await archive({ "bomb.txt": Buffer.alloc(1024 * 1024, 65) })
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    data.writeUInt32LE(16, central + 24)
    data.writeUInt32LE(16, 22)
    await expect(ProjectArchive.extract(data, path.join(tmp.path, "restored"))).rejects.toThrow()
    expect(await readdir(tmp.path)).toEqual([])
  })

  test("checks CRC and leaves an existing empty destination unchanged on failure", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "restored")
    await mkdir(destination)
    const data = await archive({ "good.ts": "good", "bad.ts": "bad" })
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    data.writeUInt32LE(0, central + 16)
    await expect(ProjectArchive.extract(data, destination)).rejects.toThrow()
    expect(await readdir(tmp.path)).toEqual(["restored"])
    expect(await readdir(destination)).toEqual([])
  })
})
