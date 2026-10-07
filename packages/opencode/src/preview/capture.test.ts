import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  PreviewUnavailableError,
  capturePreview,
  captureUrl,
  chromiumArgs,
  resolveChromium,
} from "./capture"

function pngSize(data: Buffer): { width: number; height: number } {
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

const chromium = resolveChromium()

describe("preview capture", () => {
  test("resolves a chromium binary", () => {
    expect(chromium.length).toBeGreaterThan(0)
  })

  test("pins the screenshot to the thumbnail viewport", () => {
    const args = chromiumArgs("http://127.0.0.1:5199/", "/tmp/preview.png")
    expect(args).toContain("--window-size=1200,600")
    expect(args).toContain("--screenshot=/tmp/preview.png")
    expect(args).toContain("--virtual-time-budget=6000")
    expect(args.at(-1)).toBe("http://127.0.0.1:5199/")
  })

  test("refuses to capture a project without a preview", async () => {
    let message = ""
    let tag = ""
    try {
      await capturePreview(path.join(tmpdir(), "omai-missing-preview"))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      tag = error instanceof PreviewUnavailableError ? error._tag : ""
    }
    expect(message).toBe("No preview is running for this project.")
    expect(tag).toBe("PreviewCapture.PreviewUnavailableError")
  })

  test.skipIf(process.platform === "win32")("keeps a screenshot written by a browser that exits non-zero", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omai-capture-stub-"))
    const fixture = path.join(directory, "expected.png")
    const stub = path.join(directory, "fake-chromium")
    const expected = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
      "base64",
    )
    writeFileSync(fixture, expected)
    writeFileSync(
      stub,
      '#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --screenshot=*) cp "' +
        fixture +
        '" "${arg#--screenshot=}" ;;\n  esac\ndone\nexit 1\n',
      { mode: 0o755 },
    )
    const previous = process.env.OPENCODE_CHROME_BIN
    process.env.OPENCODE_CHROME_BIN = stub
    try {
      const png = await captureUrl(`file://${path.join(directory, "page.html")}`)
      expect(png.equals(expected)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CHROME_BIN
      else process.env.OPENCODE_CHROME_BIN = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(!existsSync(chromium))("renders a fixed-size png through headless chromium", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omai-capture-test-"))
    const url = `file://${path.join(directory, "page.html")}`
    try {
      writeFileSync(
        path.join(directory, "page.html"),
        '<!doctype html><meta charset="utf-8"><title>Capture</title>' +
          "<style>html,body{margin:0;background:#0f172a;color:#fff;font:40px/600px sans-serif;text-align:center}</style>" +
          "<body>OMAI +</body>",
      )
      const png = await captureUrl(url)
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(pngSize(png)).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
