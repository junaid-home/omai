import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"

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
const prefetchedTargets = new Map<string, string>()

function newestSessionID(sessions: Session[]) {
  const sorted = [...sessions].sort(
    (a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0),
  )
  return sorted[0]?.id
}

export function prefetchProjectSessions(
  directory: string,
  listSessions: () => Promise<{ data?: Session[] }>,
  createSession?: () => Promise<{ data?: Session }>,
): Promise<{ data?: Session[] }> {
  const pending = listSessions()
    .then(async (result) => {
      const sessions = (result.data ?? []).filter((session) => !session.time?.archived)
      if (sessions.length > 0) {
        const id = newestSessionID(sessions)
        if (id) prefetchedTargets.set(directory, id)
        return result
      }
      if (!createSession) return result
      const created = await createSession()
      if (created.data) prefetchedTargets.set(directory, created.data.id)
      return created.data ? { data: [created.data] } : result
    })
    .catch((error) => {
      sessionListCache.delete(directory)
      prefetchedTargets.delete(directory)
      throw error
    })
  sessionListCache.set(directory, pending)
  return pending
}

export function prefetchedProjectTarget(directory: string): string | undefined {
  return prefetchedTargets.get(directory)
}

export function hasProjectPrefetch(directory: string) {
  return sessionListCache.has(directory)
}

export function prefetchProjectTargets(
  directories: string[],
  summary: () => Promise<{ data?: { sessions?: Session[] } }>,
): Promise<Session[]> {
  const wanted = new Set(directories)
  if (wanted.size === 0) return Promise.resolve([])
  return summary()
    .then((result) => {
      const updated = (item: Session) => item.time?.updated ?? item.time?.created ?? 0
      const newest = new Map<string, Session>()
      for (const session of result.data?.sessions ?? []) {
        if (!session?.id || !session.directory) continue
        if (session.time?.archived) continue
        if (!wanted.has(session.directory)) continue
        const current = newest.get(session.directory)
        if (current && updated(current) > updated(session)) continue
        newest.set(session.directory, session)
      }
      for (const [directory, session] of newest) {
        prefetchedTargets.set(directory, session.id)
        sessionListCache.set(directory, Promise.resolve({ data: [session] }))
      }
      return [...newest.values()]
    })
    .catch(() => [])
}

// Final navigation target for a project row: the prefetched latest session when
// the prefetch resolved, otherwise the bare project shell (the empty
// new-session route) as a safe fallback.
export function prefetchedProjectHref(directory: string, serverKey: ServerConnection.Key) {
  const id = prefetchedTargets.get(directory)
  return id ? sessionHref(serverKey, id) : `/${base64Encode(directory)}/session`
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
      const id = newestSessionID(sessions)
      if (id) return id
      return createSession().then((created) => created.data?.id)
    })
    .then((id) => navigate(id ? sessionHref(id) : `/${base64Encode(directory)}/session`))
    .catch(() => navigate(`/${base64Encode(directory)}/session`))
}
