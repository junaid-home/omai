// Lighthouse and the PDF report both drive a Chrome the machine already has; neither downloads one.

import { accessSync, constants } from "node:fs"
import path from "node:path"

const DARWIN = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]

const LINUX = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]

const WINDOWS = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Chromium\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
]

/** The Chrome to run: `CHROME_PATH` when set, else the first Chrome-like browser installed. */
export function findChrome(env: Record<string, string | undefined> = process.env) {
  if (env.CHROME_PATH && runnable(env.CHROME_PATH)) return env.CHROME_PATH

  if (process.platform === "darwin") return DARWIN.find(runnable)

  if (process.platform === "win32")
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
      .filter((base): base is string => !!base)
      .flatMap((base) => WINDOWS.map((file) => path.join(base, file)))
      .find(runnable)

  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => LINUX.map((name) => path.join(dir, name)))
    .find(runnable)
}

function runnable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
