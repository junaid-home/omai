// Prints a report page to PDF with headless Chrome. The client writes the page in the user's language; this only
// prints it, so the PDF reads exactly like the panel.

import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const TIMEOUT = 60_000

export async function printPdf(input: { html: string; chrome: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "omai-report-"))
  const page = path.join(dir, "report.html")
  const out = path.join(dir, "report.pdf")

  try {
    await writeFile(page, input.html)
    await run(input.chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      "--virtual-time-budget=2000",
      `--user-data-dir=${path.join(dir, "profile")}`,
      `--print-to-pdf=${out}`,
      pathToFileURL(page).href,
    ])

    // Chrome can exit non-zero after it wrote the file, from helper processes it tears down; the file decides.
    const pdf = await readFile(out).catch(() => undefined)

    if (!pdf?.length) throw new Error("Chrome could not print the report.")

    return pdf
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Printing the report took too long."))
    }, TIMEOUT)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Chrome could not start."))
    })
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
