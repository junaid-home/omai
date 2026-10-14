import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

// Resolve the most recent (or a freshly created) session first, then navigate
// straight to its canonical server-scoped URL. This avoids parking the user on
// the legacy directory-scoped session route while the backend boots the
// project. Falls back to the bare project route (the empty new-session shell)
// when resolution fails so the click never lands on a dead end.

// Session lists fetched ahead of a click so navigation does not wait on the
// backend project boot. Projects without sessions also get one created during
// the prefetch so the click resolves to a ready target. Failed prefetches are
// evicted so a later click retries.
const sessionListCache = new Map<string, Promise<{ data?: Session[] }>>()

export function prefetchProjectSessions(
  directory: string,
  listSessions: () => Promise<{ data?: Session[] }>,
  createSession?: () => Promise<{ data?: Session }>,
): Promise<{ data?: Session[] }> {
  const pending = listSessions()
    .then(async (result) => {
      const sessions = (result.data ?? []).filter((session) => !session.time?.archived)
      if (sessions.length > 0 || !createSession) return result
      const created = await createSession()
      return created.data ? { data: [created.data] } : result
    })
    .catch((error) => {
      sessionListCache.delete(directory)
      throw error
    })
  sessionListCache.set(directory, pending)
  return pending
}

export function openProjectImmediate(
  directory: string,
  navigate: (href: string) => void,
  sessionHref: (sessionID: string) => string,
  listSessions: () => Promise<{ data?: Session[] }>,
  createSession: () => Promise<{ data?: Session }>,
): Promise<void> {
  return (sessionListCache.get(directory) ?? listSessions())
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
