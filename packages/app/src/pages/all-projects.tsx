import { centralRuntime } from "@/utils/central-state"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { A, useLocation, useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useAuth } from "@/context/auth"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogOpenPath } from "@/components/dialog-open-path"
import {
  hasProjectPrefetch,
  openProjectImmediate,
  prefetchProjectSessions,
  prefetchedProjectHref,
  prefetchedProjectTarget,
} from "@/utils/open-project"
import { sessionHref } from "@/utils/session-route"

type ViewMode = "grid" | "list"
const ITEMS_PER_ROW = 3
const ROWS_PER_PAGE = 3
const ITEMS_PER_PAGE = ITEMS_PER_ROW * ROWS_PER_PAGE

function formatRelativeTime(
  timestamp: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)

  if (seconds < 60) return t("common.time.justNow")
  if (minutes < 60) return t("common.time.minutesAgo.short", { count: minutes })
  if (hours < 24) return t("common.time.hoursAgo.short", { count: hours })
  if (days < 7) return t("common.time.daysAgo.short", { count: days })
  if (weeks < 4) return t("common.time.weeksAgo.short", { count: weeks })
  if (months < 12) return t("common.time.monthsAgo.short", { count: months })
  return new Date(timestamp).toLocaleDateString()
}

function getProjectName(directory: string): string {
  return directory.split("/").filter(Boolean).pop() || directory
}

function ThumbnailFallback() {
  return (
    <div class="w-full h-full bg-gradient-to-br from-slate-800 to-slate-900 flex flex-col">
      <div class="flex items-center gap-1.5 px-3 py-2 bg-slate-700/50">
        <div class="w-2.5 h-2.5 rounded-full bg-red-400/60" />
        <div class="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
        <div class="w-2.5 h-2.5 rounded-full bg-green-400/60" />
        <div class="flex-1 mx-2 h-4 rounded bg-slate-600/50" />
      </div>
      <div class="flex-1 p-4 flex flex-col gap-2">
        <div class="h-2 w-3/4 rounded bg-slate-600/40" />
        <div class="h-2 w-1/2 rounded bg-slate-600/30" />
        <div class="h-2 w-2/3 rounded bg-slate-600/20" />
        <div class="mt-2 h-8 w-full rounded bg-slate-600/20" />
        <div class="h-8 w-1/2 rounded bg-slate-600/20" />
      </div>
    </div>
  )
}

function getThumbnailUrl(directory: string, serverUrl: string): string {
  return `${serverUrl}/preview/thumbnail/${base64Encode(directory)}`
}

function ProjectThumbnail(props: { directory: string; projectName: string; serverUrl: string }) {
  const [imageError, setImageError] = createSignal(false)
  const thumbnailUrl = createMemo(() => getThumbnailUrl(props.directory, props.serverUrl))

  return (
    <div class="relative w-full h-44 bg-surface-raised-base rounded-lg overflow-hidden">
      <Show when={!imageError()} fallback={<ThumbnailFallback />}>
        <img
          src={thumbnailUrl()}
          alt={`${props.projectName} preview`}
          class="w-full h-full object-cover"
          onError={() => setImageError(true)}
        />
      </Show>
    </div>
  )
}

export default function AllProjectsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const pickDirectory = useDirectoryPicker()
  const auth = useAuth()
  const layout = useLayout()

  const [viewMode, setViewMode] = createSignal<ViewMode>("grid")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [currentPage, setCurrentPage] = createSignal(1)
  const [opening, setOpening] = createSignal<string | null>(null)

  createEffect(() => {
    if (opening() && !location.pathname.startsWith("/projects")) setOpening(null)
  })

  const serverUrl = createMemo(() => server.current?.http.url ?? "")

  const allProjects = createMemo(() => {
    const projects = server.projects.list()
    if (centralRuntime.get().mode === "central") return projects
    const username = auth.user()?.username
    if (!username) return projects
    return projects.filter((p) => p.worktree.includes(`/${username}/projects/`))
  })

  const filteredProjects = createMemo(() => {
    const query = searchQuery().toLowerCase()
    const projects = allProjects()

    if (!query) return projects

    return projects.filter((project) => {
      const name = getProjectName(project.worktree).toLowerCase()
      return name.includes(query) || project.worktree.toLowerCase().includes(query)
    })
  })

  const totalPages = createMemo(() => Math.ceil(filteredProjects().length / ITEMS_PER_PAGE))

  const paginatedProjects = createMemo(() => {
    const projects = filteredProjects()
    const page = currentPage()
    const start = (page - 1) * ITEMS_PER_PAGE
    return projects.slice(start, start + ITEMS_PER_PAGE)
  })

  const openProject = (directory: string) => {
    server.projects.open(directory)
    server.projects.touch(directory)
    layout.sidebar.close()
    setOpening(directory)

    openProjectImmediate(
      directory,
      navigate,
      (id) => sessionHref(server.key, id),
      () => serverSDK().client.session.list({ directory }),
      () => serverSDK().client.session.create({ directory }),
    )
  }

  // Resolve visible projects' latest sessions up front so rows are plain links;
  // session-less projects keep resolving at click time so browsing or searching
  // does not eagerly create sessions.
  createEffect(() => {
    paginatedProjects()
      .filter((project) => !hasProjectPrefetch(project.worktree))
      .forEach((project) => {
        prefetchProjectSessions(project.worktree, () =>
          serverSDK().client.session.list({ directory: project.worktree }),
        ).catch(() => {})
      })
  })

  // Shared row/card click: navigate as a link when the target was prefetched,
  // otherwise fall back to the async open flow (which shows the spinner).
  const handleOpen = (directory: string, event: MouseEvent) => {
    if (!prefetchedProjectTarget(directory)) {
      event.preventDefault()
      openProject(directory)
      return
    }
    server.projects.open(directory)
    server.projects.touch(directory)
    layout.sidebar.close()
  }

  const openNewProjectDialog = () => {
    dialog.show(
      () => (
        <DialogOpenPath
          onCreated={(path) => {
            openProject(path)
          }}
        />
      ),
      () => {},
    )
  }

  const openOpenProjectDialog = () => {
    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        result.forEach(openProject)
      } else if (result) {
        openProject(result)
      }
    }

    pickDirectory({
      server: server.current!,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const deleteProject = (directory: string) => {
    const projectName = getProjectName(directory)
    const [deleting, setDeleting] = createSignal(false)
    dialog.show(
      () => (
        <Dialog size="normal" class="max-w-[400px] translate-x-[100px]" title={language.t("projects.delete.title")} fit>
          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
            <div class="flex flex-col gap-1">
              <span class="text-14-regular text-text-strong">
                {language.t("projects.delete.confirm", { name: projectName })}
              </span>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" disabled={deleting()} onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
                disabled={deleting()}
                onClick={() => {
                  if (deleting()) return
                  setDeleting(true)
                  const project = serverSync().data.project.find((item) => item.worktree === directory)
                  void (async () => {
                    try {
                      if (project) {
                        const result = await serverSDK().client.project.delete({ projectID: project.id, directory })
                        if (result.error) {
                          setDeleting(false)
                          return
                        }
                        serverSync().set(
                          "project",
                          serverSync().data.project.filter((item) => item.id !== project.id),
                        )
                      }
                      server.projects.close(directory)
                      dialog.close()
                    } catch {
                      setDeleting(false)
                    }
                  })()
                }}
              >
                <Show when={deleting()} fallback={language.t("common.delete")}>
                  <LoaderV2 class="shrink-0" />
                </Show>
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {},
    )
  }

  return (
    <div class="mx-auto mt-6 w-full px-4 max-w-6xl">
      {/* Header */}
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <Icon name="folder" size="medium" class="text-icon-base" />
          <h1 class="text-18-semibold text-text-strong">{language.t("projects.title")}</h1>
        </div>
        <div class="flex items-center gap-2">
          <Button
            size="normal"
            variant="secondary"
            icon="folder-add-left"
            class="pl-2 pr-3"
            onClick={openNewProjectDialog}
          >
            {language.t("projects.new")}
          </Button>
        </div>
      </div>

      {/* Search and View Toggle */}
      <div class="flex items-center justify-between gap-3 mb-6">
        <div class="relative max-w-md w-full">
          <div class="absolute left-3 top-1/2 -translate-y-1/2 text-icon-weak pointer-events-none">
            <Icon name="magnifying-glass" size="small" />
          </div>
          <input
            type="text"
            placeholder={language.t("allProjects.searchPlaceholder")}
            value={searchQuery()}
            onInput={(e) => {
              setSearchQuery(e.currentTarget.value)
              setCurrentPage(1)
            }}
            class="w-full pl-9 pr-3 py-2 text-14-regular bg-surface-raised-base border border-border-weaker-base rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-base text-text-base placeholder:text-text-weak"
          />
        </div>
        <div class="flex items-center bg-surface-raised-base border border-border-weaker-base rounded-lg p-1">
          <button
            type="button"
            class={`p-1.5 rounded-md cursor-pointer flex items-center justify-center transition-colors ${
              viewMode() === "grid"
                ? "bg-surface-raised-base-hover text-text-strong"
                : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => setViewMode("grid")}
            aria-label={language.t("allProjects.view.grid")}
          >
            <Icon name="bullet-list" size="small" />
          </button>
          <button
            type="button"
            class={`p-1.5 rounded-md cursor-pointer flex items-center justify-center transition-colors ${
              viewMode() === "list"
                ? "bg-surface-raised-base-hover text-text-strong"
                : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => setViewMode("list")}
            aria-label={language.t("allProjects.view.list")}
          >
            <Icon name="menu" size="small" />
          </button>
        </div>
      </div>

      {/* Projects Grid/List */}
      <Show
        when={filteredProjects().length > 0}
        fallback={
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">
                {searchQuery() ? language.t("allProjects.noResults") : language.t("projects.empty.title")}
              </div>
              <div class="text-12-regular text-text-weak">
                {searchQuery()
                  ? language.t("allProjects.tryDifferentSearch")
                  : language.t("projects.empty.description")}
              </div>
            </div>
          </div>
        }
      >
        <Show
          when={viewMode() === "grid"}
          fallback={
            <ul class="flex flex-col gap-1">
              <For each={paginatedProjects()}>
                {(project) => {
                  const projectName = createMemo(() => getProjectName(project.worktree))
                  return (
                    <div class="flex items-center w-full rounded-lg text-13-mono text-text-base hover:bg-surface-raised-base-hover transition-colors group">
                      <A
                        href={prefetchedProjectHref(project.worktree, server.key)}
                        class="flex items-center gap-3 flex-1 text-left px-3 py-2.5 cursor-pointer"
                        onClick={(event) => handleOpen(project.worktree, event)}
                      >
                        <Icon
                          name="folder"
                          size="small"
                          class="text-icon-weak group-hover:text-icon-base shrink-0 transition-colors"
                        />
                        <span class="truncate grow">{projectName()}</span>
                        <Show when={opening() === project.worktree}>
                          <LoaderV2 class="shrink-0 text-text-weak" />
                        </Show>
                      </A>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          size="small"
                          class="mr-1 shrink-0"
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content>
                            <DropdownMenu.Item onSelect={() => deleteProject(project.worktree)}>
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </div>
                  )
                }}
              </For>
            </ul>
          }
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={paginatedProjects()}>
              {(project) => {
                const projectName = createMemo(() => getProjectName(project.worktree))
                return (
                  <div class="flex flex-col rounded-xl border border-border-weaker-base bg-surface-base hover:bg-surface-raised-base transition-colors overflow-hidden group relative">
                    <div class="p-3 pb-0">
                      <ProjectThumbnail
                        directory={project.worktree}
                        projectName={projectName()}
                        serverUrl={serverUrl()}
                      />
                    </div>
                    <Show when={opening() === project.worktree}>
                      <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-base/75">
                        <LoaderV2 class="text-text-weak" />
                      </div>
                    </Show>
                    <div class="p-3 cursor-pointer flex items-start justify-between">
                      <A
                        href={prefetchedProjectHref(project.worktree, server.key)}
                        class="flex flex-col gap-0.5 min-w-0 flex-1 cursor-pointer"
                        onClick={(event) => handleOpen(project.worktree, event)}
                      >
                        <span class="text-14-medium text-text-strong truncate">{projectName()}</span>
                      </A>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          size="small"
                          class="shrink-0"
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content>
                            <DropdownMenu.Item onSelect={() => deleteProject(project.worktree)}>
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>

      {/* Pagination */}
      <Show when={totalPages() > 1}>
        <div class="flex items-center justify-center gap-2 mt-8 mb-6">
          <Button
            variant="ghost"
            size="normal"
            icon="chevron-left"
            disabled={currentPage() === 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          >
            {language.t("allProjects.pagination.previous")}
          </Button>
          <div class="flex items-center gap-1">
            <For each={Array.from({ length: totalPages() }, (_, i) => i + 1)}>
              {(page) => (
                <button
                  type="button"
                  class={`px-3 py-1.5 text-14-medium rounded-lg transition-colors ${
                    page === currentPage()
                      ? "bg-accent-base text-white"
                      : "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover"
                  }`}
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </button>
              )}
            </For>
          </div>
          <Button
            variant="ghost"
            size="normal"
            icon="chevron-right"
            disabled={currentPage() === totalPages()}
            onClick={() => setCurrentPage((p) => Math.min(totalPages(), p + 1))}
          >
            {language.t("allProjects.pagination.next")}
          </Button>
        </div>
      </Show>

      {/* Results count */}
      <div class="text-center text-12-regular text-text-weak my-6">
        {language.t("allProjects.showingResults", {
          count: filteredProjects().length,
          total: allProjects().length,
        })}
      </div>
    </div>
  )
}
