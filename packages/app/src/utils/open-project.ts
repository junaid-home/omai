import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

// Resolve the most recent (or a freshly created) session first, then navigate
// straight to its canonical server-scoped URL. This avoids parking the user on
// the legacy directory-scoped session route while the backend boots the
// project. Falls back to the bare project route (the empty new-session shell)
// when resolution fails so the click never lands on a dead end.
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
      if (sessions.length > 0) {
        const sorted = [...sessions].sort(
          (a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0),
        )
        return sorted[0].id
      }
      return createSession().then((created) => created.data?.id)
    })
    .then((id) => navigate(id ? sessionHref(id) : `/${base64Encode(directory)}/session`))
    .catch(() => navigate(`/${base64Encode(directory)}/session`))
}
