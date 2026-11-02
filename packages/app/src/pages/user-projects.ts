import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useAuth } from "@/context/auth"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { centralRuntime } from "@/utils/central-state"

/**
 * The signed-in user's projects for the projects pages: the server's list
 * (which holds only their own), recently opened ones first. The browser's
 * saved list alone was empty in any browser that had not opened a project
 * yet, however many the user owns.
 */
export function useUserProjects() {
  const server = useServer()
  const serverSync = useServerSync()
  const auth = useAuth()
  const query = useQuery(() => serverSync().queryOptions.projects())

  const list = createMemo(() => {
    const saved = server.projects.list().map((project) => project.worktree)
    // Until the server answers, or if it cannot, the saved list stands in.
    const live =
      query.data?.map((project) => ({ worktree: project.worktree, updated: project.time.updated ?? 0 })) ??
      (query.isPending ? [] : saved.map((worktree) => ({ worktree, updated: 0 })))
    const rank = (worktree: string) => {
      const index = saved.indexOf(worktree)
      return index === -1 ? saved.length : index
    }
    const shown = new Set(
      visible(
        live.map((project) => project.worktree),
        auth.user()?.username,
      ),
    )
    return live
      .filter((project) => shown.has(project.worktree))
      .toSorted((a, b) => rank(a.worktree) - rank(b.worktree) || b.updated - a.updated)
      .map((project) => ({ worktree: project.worktree }))
  })

  return { list, pending: () => query.isPending }
}

// Outside a central deployment the server lists every project on the
// machine; only VM projects and the user's own folder are shown.
function visible(worktrees: string[], username: string | undefined) {
  if (centralRuntime.get().mode === "central") return worktrees
  const projectsRoot = centralRuntime.get().projectsRoot
  const vmWorkspacePrefix = projectsRoot ? `${projectsRoot}/workspace` : "/home/runner/workspace"
  return worktrees.filter((worktree) => {
    if (worktree.startsWith(vmWorkspacePrefix)) return true
    if (!username) return true
    return worktree.includes(`/${username}/projects/`)
  })
}
