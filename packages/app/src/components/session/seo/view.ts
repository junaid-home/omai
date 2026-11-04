// One project's website audit: the audit in progress, the report on screen, the kept history, and the fix the agent is
// working on. It lives per project directory, outside the tab, so an audit carries on and its state survives while
// the tab is closed or another tab is open.

import { batch, createMemo, createRoot, createSignal, onCleanup, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { compare, fixPrompt, type Comparison, type Target, type Translate } from "./model"
import type { Audit } from "./types"

/** Reports kept per project. */
const KEEP = 10

export type FixPhase = "idle" | "asking" | "running" | "auditing" | "stopped" | "done" | "error"

/** What the view needs from the screen it is shown on; the tab passes the current ones each time it mounts. */
export interface AuditDeps {
  /** Runs the audit on the server. Rejects with the server's error. */
  report(input: { formFactor: Audit.FormFactor; url?: string; locale: string; signal: AbortSignal }): Promise<Audit.Report>
  /** Starts the project's preview when it is not running. */
  ensurePreview(): Promise<void>
  pdf(html: string): Promise<{ readonly base64: string }>
  /** Sends the prompt to the open session's agent, or rejects when there is no session. */
  prompt(text: string): Promise<void>
  /** Stops the open session's agent. */
  abort(): Promise<void>
  t: Translate
  locale(): string
}

type State = {
  running?: { startedAt: number; step: "preview" | "lighthouse"; preview: boolean }
  formFactor: Audit.FormFactor
  target: "preview" | "url"
  url: string
  /** The report on screen: the newest one unless the user opened another from the history. */
  openedID?: string
  error?: string
  fix: {
    phase: FixPhase
    target?: Target
    baseline?: Audit.Report
    startedAt?: number
    sawBusy: boolean
    comparison?: Comparison
    error?: string
  }
}

export type AuditView = ReturnType<typeof createView>

const views = new Map<string, AuditView>()

/**
 * The project's view: created once per server and directory and kept for the life of the page. It takes the tab's
 * owner only for the app's contexts, like the storage platform; closing the tab does not dispose it.
 */
export function auditView(project: { scope: ServerScope; directory: string }, deps: AuditDeps, owner: Owner | null) {
  const key = `${project.scope}\n${project.directory}`
  const existing = views.get(key)

  if (existing) {
    existing.bind(deps)
    return existing
  }
  // `dispose` must be a parameter: Solid gives a root that takes none no context at all, and the history store reads
  // the app's storage platform from context. The view lives for the page, so it is never disposed.
  const created = createRoot((_dispose) => createView(project, deps), owner ?? undefined)
  views.set(key, created)

  return created
}

type ServerScope = Parameters<typeof Persist.serverWorkspace>[0]

function createView(project: { scope: ServerScope; directory: string }, initial: AuditDeps) {
  const deps = { current: initial }
  const [state, setState] = createStore<State>({
    formFactor: "mobile",
    target: "preview",
    url: "",
    fix: { phase: "idle", sawBusy: false },
  })
  const [history, setHistory] = persisted(
    Persist.serverWorkspace(project.scope, project.directory, "seo.history"),
    createStore({ reports: [] as Audit.Report[] }),
  )
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)
  const abort = { current: undefined as AbortController | undefined }

  const timer = setInterval(() => {
    if (state.running || ["asking", "running", "auditing"].includes(state.fix.phase)) setNow(Date.now())
  }, 1000)
  onCleanup(() => clearInterval(timer))

  const report = createMemo(() => {
    const opened = state.openedID ? history.reports.find((item) => item.id === state.openedID) : undefined

    return opened ?? history.reports[0]
  })
  const running = () => !!state.running
  const fixActive = () => ["asking", "running", "auditing"].includes(state.fix.phase)

  const reason = (error: { readonly message?: string } | undefined) => error?.message ?? ""

  // Runs one audit to the end and keeps its report; resolves to it, or to nothing when it failed or was cancelled.
  const run = async (input: { formFactor: Audit.FormFactor; url?: string }) => {
    if (state.running) return undefined
    const controller = new AbortController()
    abort.current = controller
    const preview = !input.url?.trim()
    setState({ error: undefined, running: { startedAt: Date.now(), step: preview ? "preview" : "lighthouse", preview } })
    setNow(Date.now())

    const result = await (async () => {
      if (preview) await deps.current.ensurePreview()

      if (controller.signal.aborted) return undefined
      setState("running", "step", "lighthouse")

      return deps.current.report({
        formFactor: input.formFactor,
        url: preview ? undefined : input.url,
        locale: deps.current.locale(),
        signal: controller.signal,
      })
    })().then(
      (value) => ({ value }),
      (error: { readonly message?: string } | undefined) => ({ error: reason(error) }),
    )

    // A cancelled audit, or one a newer run replaced, leaves no trace.
    if (abort.current !== controller) return undefined
    abort.current = undefined

    return batch(() => {
      setState("running", undefined)

      if (controller.signal.aborted) return undefined

      if ("error" in result) {
        setState("error", result.error || deps.current.t("failed", { reason: "" }))
        return undefined
      }

      if (!result.value) return undefined
      setHistory("reports", reconcile([result.value, ...history.reports].slice(0, KEEP)))
      setState("openedID", undefined)

      return result.value
    })
  }

  const remeasure = () => {
    const baseline = state.fix.baseline

    if (!baseline) return
    setState("fix", { phase: "auditing", sawBusy: false })
    void run({ formFactor: baseline.formFactor, url: baseline.preview ? undefined : baseline.url }).then((after) => {
      if (state.fix.phase !== "auditing") return

      if (!after) return setState("fix", { phase: "error", error: deps.current.t("optimize.auditFailed") })
      setState("fix", { phase: "done", comparison: compare(baseline, after, state.fix.target, deps.current.t) })
    })
  }

  return {
    state: {
      get status() {
        return { running: state.running, error: state.error, latest: history.reports[0], history: history.reports }
      },
      get formFactor() {
        return state.formFactor
      },
      get target() {
        return state.target
      },
      get url() {
        return state.url
      },
      get error() {
        return undefined
      },
      get fix() {
        return state.fix
      },
    },
    report,
    running,
    fixActive,
    agentBusy: busy,
    elapsed: () => now() - (state.fix.startedAt ?? now()),
    auditElapsed: () => now() - (state.running?.startedAt ?? now()),
    canFix: () => {
      const current = report()

      return !!current && current.preview && !running() && !busy() && !fixActive()
    },
    /** Takes the screen's current helpers; the tab calls it each time it mounts. */
    bind: (next: AuditDeps) => {
      deps.current = next
    },
    /**
     * Follows the open session's agent while it works on the fixes: once it went busy and is idle again, the audit
     * runs again and the comparison shows what changed.
     */
    setAgentBusy: (value: boolean) => {
      setBusy(value)

      if (state.fix.phase !== "running") return

      if (value) return setState("fix", "sawBusy", true)

      if (state.fix.sawBusy) remeasure()
    },
    setFormFactor: (formFactor: Audit.FormFactor) => setState("formFactor", formFactor),
    setTarget: (target: "preview" | "url") => setState("target", target),
    setURL: (url: string) => setState("url", url),
    run: () => void run({ formFactor: state.formFactor, url: state.target === "url" ? state.url : undefined }),
    /** Runs the report on screen again, with its own target and screen. */
    retest: () => {
      const current = report()

      if (current) void run({ formFactor: current.formFactor, url: current.preview ? undefined : current.url })
    },
    cancel: () => {
      abort.current?.abort()
      abort.current = undefined
      setState("running", undefined)
    },
    open: (id: string) => setState("openedID", id === history.reports[0]?.id ? undefined : id),
    remove: (id: string) =>
      batch(() => {
        if (state.openedID === id) setState("openedID", undefined)
        setHistory("reports", (reports) => reports.filter((item) => item.id !== id))
      }),
    pdf: (html: string) => deps.current.pdf(html),
    fix: (target?: Target) => {
      const current = report()

      if (!current) return
      setState("fix", {
        phase: "asking",
        target,
        baseline: current,
        startedAt: Date.now(),
        sawBusy: false,
        comparison: undefined,
        error: undefined,
      })
      setNow(Date.now())
      void deps.current.prompt(fixPrompt(current, target, deps.current.t)).then(
        () => state.fix.phase === "asking" && setState("fix", "phase", "running"),
        (error: { readonly message?: string } | undefined) =>
          setState("fix", { phase: "error", error: deps.current.t("optimize.failed", { reason: reason(error) }) }),
      )
    },
    stopFix: () => {
      setState("fix", { phase: "stopped", sawBusy: false })
      void deps.current.abort().catch(() => undefined)
    },
    dismissFix: () => setState("fix", { phase: "idle", target: undefined, baseline: undefined, comparison: undefined }),
  }
}
