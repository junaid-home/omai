import { Option, Schema } from "effect"

// A MicroVM creation is a durable job stored as `extra.provision` on its
// workspace row, so a control-plane restart can resume or clean it up from
// the recorded step. Rows without it predate jobs and count as ready.

export const Step = Schema.Literals(["creating", "booting", "setup", "upload", "done"])
export const Status = Schema.Literals(["running", "ready", "failed"])
/** `recover` re-provisions an existing project and must never delete its volume. */
export const Kind = Schema.Literals(["new", "recover"])
/** `upload`: the browser uploads a zip into the booted VM to finish the job. */
export const Mode = Schema.Literals(["empty", "upload"])

export const State = Schema.Struct({
  status: Status,
  step: Step,
  kind: Kind,
  mode: Mode,
  error: Schema.optional(Schema.String),
  cleaned: Schema.Boolean,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  deadline: Schema.Number,
  timings: Schema.Record(Schema.String, Schema.Number),
})
export type State = Schema.Schema.Type<typeof State>

const decode = Schema.decodeUnknownOption(Schema.Struct({ provision: State }))

export function read(extra: unknown): State | undefined {
  return Option.getOrUndefined(decode(extra))?.provision
}

export function write(extra: unknown, state: State): Record<string, unknown> {
  const base = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}
  return { ...base, provision: state }
}

export function begin(input: { kind: State["kind"]; mode: State["mode"]; now: number; bootDeadlineMs: number }): State {
  return {
    status: "running",
    step: "creating",
    kind: input.kind,
    mode: input.mode,
    cleaned: false,
    startedAt: input.now,
    updatedAt: input.now,
    deadline: input.now + input.bootDeadlineMs,
    timings: {},
  }
}

export function advance(state: State, step: State["step"], now: number, uploadDeadlineMs: number): State {
  return {
    ...state,
    step,
    status: step === "done" ? "ready" : state.status,
    updatedAt: now,
    deadline: step === "upload" ? now + uploadDeadlineMs : state.deadline,
    timings: { ...state.timings, [state.step]: now - state.updatedAt },
  }
}

export function fail(state: State, error: string, now: number): State {
  return { ...state, status: "failed", error, cleaned: false, updatedAt: now }
}

export function cleaned(state: State, now: number): State {
  return { ...state, cleaned: true, updatedAt: now }
}

export function proxyable(state: State | undefined): boolean {
  if (!state) return true
  if (state.status === "ready") return true
  return state.status === "running" && state.step === "upload"
}

export * as ProvisionState from "./provision-state"
