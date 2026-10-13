import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks"
import { Effect, Schedule, Scope } from "effect"

/** Stalls at or above this many milliseconds are logged as warnings. */
const STALL_MS = 1000

/**
 * Warns when the main thread stops servicing timers for a second or more.
 *
 * The histogram samples from a timer, so a blocked loop inflates `max` instead
 * of silently skipping the freeze: the gap between when a sample was due and
 * when it ran is recorded as lag. Counters are reset per window so one warning
 * describes a single ten second interval rather than the process lifetime.
 */
export function watch(scope: Scope.Scope) {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  return Effect.gen(function* () {
    yield* Scope.addFinalizer(scope, Effect.sync(() => histogram.disable()))
    yield* report(histogram).pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkIn(scope))
  })
}

function report(histogram: IntervalHistogram) {
  return Effect.gen(function* () {
    const maxMs = histogram.max / 1e6
    const p99Ms = histogram.percentile(99) / 1e6
    const samples = histogram.count
    histogram.reset()
    if (maxMs < STALL_MS) return
    yield* Effect.logWarning("event loop stalled", {
      maxMs: Math.round(maxMs),
      p99Ms: Math.round(p99Ms),
      samples,
    })
  })
}

export * as EventLoopLag from "./event-loop-lag"
