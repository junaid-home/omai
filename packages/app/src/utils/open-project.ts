import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

function newestSessionID(sessions: Session[]) {
  const sorted = [...sessions].sort(
    (a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0),
  )
  return sorted[0]?.id
}

export function projectHref(directory: string) {
  return `/${base64Encode(directory)}/session`
}

type Result<A> = { data?: A; error?: unknown }

/**
 * Opens a project on its newest session, creating one when it has none.
 * A MicroVM project may still be waking when it is clicked: its requests fail
 * (503 workspace_provisioning) or answer with an error for a while, which must
 * not be mistaken for "no sessions" or end on a route with no session. Retry
 * until the VM answers (by default ~90s, enough for a cold resume).
 */
export async function openProjectImmediate(
  directory: string,
  navigate: (href: string) => void,
  sessionHref: (sessionID: string) => string,
  listSessions: () => Promise<Result<Session[]>>,
  createSession: () => Promise<Result<Session>>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 3_000
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const id = await resolveSession(listSessions, createSession).catch(() => undefined)
    if (id) return navigate(sessionHref(id))
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  navigate(projectHref(directory))
}

async function resolveSession(
  listSessions: () => Promise<Result<Session[]>>,
  createSession: () => Promise<Result<Session>>,
) {
  const listed = await listSessions()
  if (listed.error || !listed.data) return undefined
  const id = newestSessionID(listed.data.filter((session) => !session.time?.archived))
  if (id) return id
  const created = await createSession()
  return created.error ? undefined : created.data?.id
}
