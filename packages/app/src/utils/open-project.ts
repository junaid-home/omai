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

export function openProjectImmediate(
  directory: string,
  navigate: (href: string) => void,
  sessionHref: (sessionID: string) => string,
  listSessions: () => Promise<{ data?: Session[] }>,
  createSession: () => Promise<{ data?: Session }>,
): Promise<void> {
  return listSessions()
    .then((result) => {
      const sessions = (result.data ?? []).filter((session) => !session.time?.archived)
      const id = newestSessionID(sessions)
      if (id) return id
      return createSession().then((created) => created.data?.id)
    })
    .then((id) => navigate(id ? sessionHref(id) : projectHref(directory)))
    .catch(() => navigate(projectHref(directory)))
}
