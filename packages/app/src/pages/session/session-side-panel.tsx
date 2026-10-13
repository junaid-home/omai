import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { DragDropProvider as DndKitProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { BrandLogo } from "@/components/brand-logo"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { QuestionRequest, SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { PublishDialog } from "@/components/publish-dialog"

import FileTree from "@/components/file-tree"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { SessionContextUsage } from "@/components/session-context-usage"

const reviewTabID = "session-side-panel-review-tab"
const reviewTabPanelID = "session-side-panel-review-tabpanel"
const fileBrowserTabPanelID = "session-side-panel-file-browser-tabpanel"
const toolsTabID = "session-side-panel-tools-tab"
const toolsTabPanelID = "session-side-panel-tools-tabpanel"
const previewZoomOptions = [25, 50, 75, 100, 125, 150, 200]

// Strip the preview proxy prefix (`/global/preview/proxy/<port>`) and a
// trailing `.html` extension from a resolved pathname so discovered pages show
// the app's real route path (e.g. `/about.html` -> `/about`) instead of the
// proxied address. The port is optional since some previews resolve links
// without it.
function toRoutePath(pathname: string): string {
  const noPrefix = pathname.replace(/^\/global\/preview\/proxy\/\d*\/?/, "")
  const noHtml = noPrefix.replace(/\.html$/i, "")
  const noIndex = noHtml === "index" ? "" : noHtml
  const normalized = noIndex.replace(/\/+$/, "") || "/"
  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

// The preview iframe reports about:blank while it remounts (for example during a
// reload). `about:blank` parses with pathname "blank", which is not a route.
function previewRoutePath(url: string): string | undefined {
  if (!/^https?:/i.test(url)) return undefined
  try {
    return toRoutePath(new URL(url).pathname)
  } catch {
    return undefined
  }
}

import { SessionContextTab, SortableTab, SortableTabV2, FileVisual } from "@/components/session"
import { SessionToolsTab } from "@/components/session/session-tools-tab"
import { OpenInAppV2 } from "@/components/session/open-in-app-v2"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { displayName } from "@/pages/layout/helpers"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { pathKey } from "@/utils/path-key"
import {
  SESSION_OPEN_FILE_TAB,
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  projectRootFiles,
  shouldShowFileTree,
  type FileTabSource,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionFileBrowserTab, type SessionFileBrowserState } from "@/pages/session/v2/session-file-browser-tab"
import { PreviewPanel } from "@/components/preview-panel"
import { VisualEditorToggle } from "@/components/visual-editor-toggle"
import { getPreviewUrl } from "@/context/preview-lifecycle"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewHasFocusableContent: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  reviewSidebarToggle?: (disabled: boolean) => JSX.Element
  panelSizeToggle?: JSX.Element
  fileBrowserState?: SessionFileBrowserState
  diffVersion?: number
  loadDiff?: (path: string, version?: number) => Promise<RenderDiff | undefined>
  expandUnchanged?: boolean
  fileTabSource?: (tab: string) => FileTabSource | undefined
  setFileTabSource?: (tab: string, source: FileTabSource) => void
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
  stacked?: boolean
  fullScreen?: boolean
  onPreviewReady?: (ready: boolean) => void
  onActiveTabChange?: (tab: string) => void
  questionRequest?: QuestionRequest
  onQuestionDone?: () => void
  agentName?: string
  hideFileTree?: boolean
  previewReloadToken?: () => number
  onSelectCheckpoint?: (checkpointID: string) => void
}) {
  const layout = useLayout()
  const settings = useSettings()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const sdk = useSDK()
  const { sessionKey, tabs, view, params } = useSessionLayout()
  const projectDirectory = createMemo(() => sdk().directory)
  const project = createMemo(() => {
    const directory = pathKey(sdk().directory)
    return layout.projects
      .list()
      .find(
        (item) =>
          pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
      )
  })
  const projectName = createMemo(() => displayName(project() ?? { worktree: sdk().directory }))
  const downloadProject = async (name: string) => {
    try {
      const response = await fetch(`${sdk().url}/file/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: sdk().directory }),
      })
      if (!response.ok) return
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = name.endsWith(".zip") ? name : `${name}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {}
  }
  const [previewNonce, setPreviewNonce] = createSignal(0)
  const [previewReloadKey, setPreviewReloadKey] = createSignal(0)
  const [device, setDevice] = createSignal<"desktop" | "tablet" | "mobile">("desktop")
  const [zoom, setZoom] = createSignal<number>(100)
  const [origin, setOrigin] = createSignal("")
  const previewControl: {
    navigate: (url: string) => void
    reload: (path?: string) => void
    getIframe: () => HTMLIFrameElement | undefined
    onLoad: () => void
    onPages: (urls: string[]) => void
  } = {
    navigate: () => {},
    reload: () => {},
    getIframe: () => undefined,
    onLoad: () => {},
    onPages: () => {},
  }
  const sync = useSync()
  const [discoveredPages, setDiscoveredPages] = createSignal<Array<{ route: string }>>([])
  let linkObserver: MutationObserver | undefined
  let scrapeDebounce: ReturnType<typeof setTimeout> | undefined

  const deviceWidth = createMemo(() => {
    const d = device()
    if (d === "tablet") return 768
    if (d === "mobile") return 360
    return 1440
  })

  const deviceLabel = createMemo(() => {
    const d = device()
    if (d === "tablet") return "Tablet"
    if (d === "mobile") return "Mobile"
    return "Desktop"
  })

  const cycleDevice = () => {
    const d = device()
    if (d === "tablet") setDevice("mobile")
    else if (d === "mobile") setDevice("desktop")
    else setDevice("tablet")
  }

  // The preview reports its URL when it (re)starts. Adopt the route it actually
  // opened so a reload that returns to the same page does not reset the bar.
  const handleUrlChange = (url: string) => {
    try {
      setOrigin(new URL(url).origin)
    } catch {}
    const base = proxyBase().replace(/\/+$/, "")
    let rel = ""
    try {
      const path = new URL(url).pathname.replace(/\/+$/, "")
      rel = path.startsWith(base) ? path.slice(base.length) : ""
    } catch {}
    setRoute(!rel || rel === "/" ? "" : rel)
  }

  const resolveTargetUrl = (input: string) => {
    if (/^https?:\/\//i.test(input)) return input
    const base = origin()
    if (!base) return input
    return base + (input.startsWith("/") ? input : `/${input}`)
  }

  const [route, setRoute] = createSignal("")
  const [routeSearch, setRouteSearch] = createSignal("")

  const proxyBase = () => {
    const dir = projectDirectory()
    const home = dir ? getPreviewUrl(dir) : undefined
    if (!home) return ""
    try {
      return new URL(home).pathname
    } catch {
      return home
    }
  }

  const routeLabel = createMemo(() => (route() === "" ? "Homepage" : route()))

  // The poll below keeps `route` aligned with the iframe, so the active page is
  // just the signal. Reading the document here would be non-reactive and go
  // stale during navigation, leaving the check mark on the wrong route.
  const activeRoute = createMemo(() => route() || "/")

  const addressPages = createMemo(() => {
    const pages = new Map(discoveredPages().map((page) => [page.route, page]))
    pages.set("/", { route: "/" })
    const active = activeRoute()
    if (active) pages.set(active, { route: active })
    return [...pages.values()].sort((a, b) => {
      if (a.route === "/") return -1
      if (b.route === "/") return 1
      return a.route.localeCompare(b.route)
    })
  })

  const searchPath = createMemo(() => {
    const raw = routeSearch().trim()
    if (!raw) return ""
    return raw.startsWith("/") ? raw : `/${raw}`
  })

  const navigateRoute = (rel: string) => {
    const base = proxyBase().replace(/\/+$/, "")
    const originVal = origin()
    if (!originVal) return
    const isHome = rel === "" || rel === "/"
    const path = rel.replace(/^\/+/, "")
    const target = isHome ? `${originVal}${base}/` : `${originVal}${base}/${path}`
    previewControl.navigate(target)
    // The poll below can read the outgoing document while the new page loads
    // and would flip the bar back; ignore it until the navigation settles.
    navigateSuppressUntil = Date.now() + 1000
    setRoute(isHome ? "" : rel.startsWith("/") ? rel : `/${rel}`)
    setRouteSearch("")
  }

  // Keep the address bar in sync with the actual preview location. In-app
  // navigation (clicking a link/router inside the iframe) changes the iframe's
  // history but not the `route` signal, so poll the iframe's URL and adopt it.
  let routeSyncTimer: ReturnType<typeof setInterval> | undefined
  let syncedIframe: HTMLIFrameElement | undefined
  let navigateSuppressUntil = 0

  const syncRouteFromIframe = () => {
    try {
      if (Date.now() < navigateSuppressUntil) return
      const iframe = previewControl.getIframe()
      if (iframe && iframe !== syncedIframe) {
        syncedIframe = iframe
        const win = iframe.contentWindow
        win?.removeEventListener("popstate", syncRouteFromIframe)
        win?.removeEventListener("load", syncRouteFromIframe)
        win?.addEventListener("popstate", syncRouteFromIframe)
        win?.addEventListener("load", syncRouteFromIframe)
      }
      const doc = iframe?.contentDocument
      if (!doc) return
      const actual = previewRoutePath(doc.URL)
      if (!actual) return
      const current = route()
      const desired = current === "" ? "/" : current
      if (actual !== desired) {
        setRoute(actual === "/" ? "" : actual)
      }
    } catch {}
  }

  const stopRouteSync = () => {
    clearInterval(routeSyncTimer)
    routeSyncTimer = undefined
    try {
      const win = syncedIframe?.contentWindow
      win?.removeEventListener("popstate", syncRouteFromIframe)
      win?.removeEventListener("load", syncRouteFromIframe)
    } catch {}
    syncedIframe = undefined
  }

  onMount(() => {
    routeSyncTimer = setInterval(syncRouteFromIframe, 500)
  })

  onCleanup(stopRouteSync)

  const adoptPages = (pages: Array<{ route: string }>) => {
    const existing = new Map(discoveredPages().map((p) => [p.route, p]))
    for (const p of pages) existing.set(p.route, p)
    const merged = [...existing.values()]
    merged.sort((a, b) => {
      if (a.route === "/") return -1
      if (b.route === "/") return 1
      return a.route.localeCompare(b.route)
    })
    setDiscoveredPages(merged)
  }

  // The visual bridge reports absolute links from inside the preview document.
  // This is the only discovery path on prod, where the preview runs on a
  // dedicated origin and iframe.contentDocument is unreadable here.
  const adoptDiscoveredUrls = (urls: string[]) => {
    const originVal = origin()
    const seen = new Set<string>()
    const pages: Array<{ route: string }> = []
    for (const raw of urls) {
      try {
        const url = new URL(raw)
        if (url.protocol !== "http:" && url.protocol !== "https:") continue
        if (originVal && url.origin !== originVal) continue
        const path = toRoutePath(url.pathname)
        if (!path) continue
        if (seen.has(path)) continue
        seen.add(path)
        pages.push({ route: path })
      } catch {}
    }
    if (pages.length) adoptPages(pages)
  }

  const scrapeLinks = () => {
    const iframe = previewControl.getIframe()
    if (!iframe) return
    try {
      const doc = iframe.contentDocument
      if (!doc) return
      const originVal = origin()
      const refUrl = iframe.src || doc.baseURI || ""
      const links = Array.from(doc.querySelectorAll("a[href]"))
      const seen = new Set<string>()
      const pages: Array<{ route: string }> = []
      for (const link of links) {
        try {
          const href = link.getAttribute("href")
          if (!href) continue
          const url = new URL(href, refUrl)
          if (originVal && url.origin !== originVal) continue
          const path = toRoutePath(url.pathname)
          if (!path) {
            if (!seen.has("/")) {
              seen.add("/")
              pages.push({ route: "/" })
            }
            continue
          }
          if (seen.has(path)) continue
          seen.add(path)
          pages.push({ route: path })
        } catch {}
      }
      adoptPages(pages)
      setupLinkObserver(iframe)
    } catch {}
  }

  const setupLinkObserver = (iframe: HTMLIFrameElement) => {
    linkObserver?.disconnect()
    linkObserver = undefined
    try {
      const doc = iframe.contentDocument
      if (!doc?.body) return
      linkObserver = new MutationObserver(() => {
        clearTimeout(scrapeDebounce)
        scrapeDebounce = setTimeout(scrapeLinks, 300)
      })
      linkObserver.observe(doc.body, { childList: true, subtree: true })
    } catch {}
  }

  onCleanup(() => {
    linkObserver?.disconnect()
    clearTimeout(scrapeDebounce)
  })

  previewControl.onLoad = () => {
    setTimeout(scrapeLinks, 500)
  }
  previewControl.onPages = adoptDiscoveredUrls

  // Refresh the preview whenever the agent finishes responding to a prompt, so
  // file changes made during the turn are picked up by the dev server. Reload
  // silently so the iframe keeps rendering instead of flashing the loader.
  createEffect(
    on(
      () => (params.id ? sync().data.session_working(params.id) : false),
      (working, prev) => {
        if (prev !== true || working) return
        const dir = sdk().directory
        if (!dir || !getPreviewUrl(dir)) return
        setPreviewReloadKey((n) => n + 1)
      },
    ),
  )

  // A checkpoint rollback rewrites files on disk outside a session turn, so
  // reload the preview the same way as the end-of-turn refresh.
  createEffect(
    on(
      () => props.previewReloadToken?.() ?? 0,
      (token, prev) => {
        if (prev === undefined || token === prev) return
        const dir = sdk().directory
        if (!dir || !getPreviewUrl(dir)) return
        setPreviewReloadKey((n) => n + 1)
      },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const diffForTab = (tab: string) => {
    const path = file.pathFromTab(tab)
    if (!path) return
    return props.diffs().find((diff): diff is RenderDiff => renderDiff(diff) && diff.file === path)
  }

  const shown = settings.visibility.fileTree

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return "auto"
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalizeFileTreeV2Path(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return projectRootFiles(file.tree.children("")).length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
    fileBrowser: () => !!props.fileBrowserState,
  })
  const contextOpen = tabState.contextOpen
  const openFileOpen = tabState.openFileOpen
  const panelTabs = tabState.panelTabs
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const stripTabs = createMemo(() => [...openedTabs()])

  const isCodeActive = createMemo(
    () =>
      activeTab() !== undefined &&
      activeTab() !== "preview" &&
      activeTab() !== "review" &&
      activeTab() !== "context" &&
      activeTab() !== "tools" &&
      activeTab() !== "empty",
  )

  const isFilesChangedActive = createMemo(() => reviewTab() && props.canReview() && activeTab() === "review")

  const headerActions = [
    {
      key: "code",
      icon: <IconV2 name="code-v2" size="small" />,
      label: () => "Code",
      menuLabel: () => "Code",
      active: () => isCodeActive(),
      onClick: () => openFileBrowser(),
      aria: () => language.t("command.file.open"),
    },
    {
      key: "review",
      icon: <IconV2 name="review" size="small" />,
      label: () => language.t("session.review.filesChanged", { count: props.reviewCount() }),
      menuLabel: () => language.t("session.review.filesChanged", { count: props.reviewCount() }),
      active: () => isFilesChangedActive(),
      onClick: () => activateTab("review"),
      aria: () => language.t("command.file.open"),
    },
    {
      key: "tools",
      icon: <IconV2 name="wrench" size="small" />,
      label: () => "Tools",
      menuLabel: () => "Tools",
      active: () => activeTab() === "tools",
      onClick: () => activateTab("tools"),
      aria: () => "Tools",
    },
  ] as const

  let capsuleRef: HTMLDivElement | undefined
  let previewButtonRef: HTMLButtonElement | undefined
  let routeSearchRef: HTMLInputElement | undefined

  const inlineHeaderActions = createMemo(() => headerActions)

  createEffect(() => {
    props.onActiveTabChange?.(activeTab() ?? "")
  })

  const showAllFiles = () => {}

  let fileFilter: HTMLInputElement | undefined
  let tabList: HTMLDivElement | undefined
  const temporaryTab = tabs().preview
  const previewTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().previewTab(next)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    queueMicrotask(() => tabs().setActive(next))
  }
  const openFileBrowser = () => {
    previewTab(SESSION_OPEN_FILE_TAB)
    queueMicrotask(() => fileFilter?.focus())
  }
  const activateTab = (value: string) => {
    const next = normalizeTab(value)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    tabs().setActive(next)
  }
  const browserTab = createMemo(() => {
    if (!props.fileBrowserState) return undefined
    const active = activeTab()
    if (active === SESSION_OPEN_FILE_TAB) return SESSION_OPEN_FILE_TAB
    if (active && file.pathFromTab(active)) return active
    return activeFileTab() ?? SESSION_OPEN_FILE_TAB
  })
  const browserSource = createMemo(() => {
    const tab = browserTab() ?? activeFileTab()
    if (!tab) return undefined
    return props.fileTabSource?.(tab)
  })
  const browserDiff = createMemo(() => {
    if (browserSource() !== "git") return undefined
    const tab = browserTab() ?? activeFileTab() ?? ""
    return diffForTab(tab)
  })
  // Keep the file-browser shell mounted while any file tab exists. Kobalte briefly
  // selects Review while the tab For replaces a preview trigger, which would
  // otherwise dispose the sidebar and reset scroll.
  const fileBrowserMounted = createMemo(() => {
    if (!props.fileBrowserState) return false
    return openedTabs().length > 0 || openFileOpen() || !!browserTab()
  })
  const fileBrowserVisible = createMemo(() => {
    const active = activeTab()
    return active !== "review" && active !== "context" && active !== "tools"
  })
  const openFileKeybind = createMemo(() => command.keybindParts("file.open"))
  const closeTabKeybind = createMemo(() => command.keybindParts("tab.close"))
  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 flex overflow-hidden"
        classList={{
          "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
          "bg-background-base": !settings.general.newLayoutDesigns(),
          "h-full shrink-0": !props.stacked,
          "h-full min-h-0": props.stacked,
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden":
            settings.general.newLayoutDesigns() && !props.fullScreen,
          "flex-1": reviewOpen(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns() && !props.fullScreen,
            }}
          >
            <Show when={reviewOpen()}>
              <div
                class="relative min-w-0 h-full flex-1 overflow-hidden"
                classList={{
                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                  "bg-background-base": !settings.general.newLayoutDesigns(),
                }}
              >
                <div
                  class="size-full min-w-0 h-full"
                  classList={{
                    "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                    "bg-background-base": !settings.general.newLayoutDesigns(),
                  }}
                >
                  <Show
                    when={props.fileBrowserState}
                    fallback={
                      <DragDropProvider
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragYAxis />
                        <Tabs value={activeTab()} onChange={activateTab}>
                          <div class="sticky top-0 shrink-0 flex">
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={reviewTab() && props.canReview()}>
                                <Tabs.Trigger
                                  value="review"
                                  id={reviewTabID}
                                  aria-controls={activeTab() === "review" ? reviewTabPanelID : undefined}
                                >
                                  <div class="flex items-center gap-1.5">
                                    <div>{language.t("session.tab.review")}</div>
                                    <Show when={props.hasReview()}>
                                      <div>{props.reviewCount()}</div>
                                    </Show>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={contextOpen()}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={activeTab() === "tools"}>
                                <Tabs.Trigger
                                  value="tools"
                                  id={toolsTabID}
                                  aria-controls={activeTab() === "tools" ? toolsTabPanelID : undefined}
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-4 w-4"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("tools")}
                                >
                                  <div class="flex items-center gap-2">
                                    <IconV2 name="wrench" size="small" />
                                    <div>{language.t("session.tools.title")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <SortableProvider ids={openedTabs()}>
                                <For each={panelTabs()}>
                                  {(tab) => (
                                    <Show
                                      when={tab === SESSION_OPEN_FILE_TAB}
                                      fallback={
                                        <SortableTab
                                          tab={tab}
                                          temporary={temporaryTab() === tab}
                                          onTabClose={tabs().close}
                                          onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                                        />
                                      }
                                    >
                                      <Tabs.Trigger
                                        value={SESSION_OPEN_FILE_TAB}
                                        closeButton={
                                          <TooltipKeybind
                                            title={language.t("common.closeTab")}
                                            keybind={command.keybind("tab.close")}
                                            placement="bottom"
                                            gutter={10}
                                          >
                                            <IconButton
                                              icon="close-small"
                                              variant="ghost"
                                              class="h-5 w-5"
                                              onClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                              aria-label={language.t("common.closeTab")}
                                            />
                                          </TooltipKeybind>
                                        }
                                        hideCloseButton
                                        onMiddleClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                      >
                                        <div class="flex items-center gap-1.5 italic">
                                          <Icon name="open-file" size="small" />
                                          <span>{language.t("command.file.open")}</span>
                                        </div>
                                      </Tabs.Trigger>
                                    </Show>
                                  )}
                                </For>
                              </SortableProvider>
                              <div
                                class="h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3"
                                classList={{
                                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                                  "bg-background-stronger": !settings.general.newLayoutDesigns(),
                                }}
                              >
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={() => {
                                      void import("@/components/dialog-select-file").then((x) => {
                                        dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                                      })
                                    }}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </div>

                          <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                            <div
                              id={reviewTabPanelID}
                              role="tabpanel"
                              aria-labelledby={reviewTabID}
                              tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                              data-slot="tabs-content"
                              class="flex flex-col h-full overflow-hidden contain-strict"
                            >
                              {props.reviewPanel()}
                            </div>
                          </Show>

                          <Show when={activeTab() === "empty"}>
                            <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                  <BrandLogo size="medium" class="opacity-10" />
                                  <div class="text-14-regular text-text-weak max-w-56">
                                    {language.t("session.files.selectToOpen")}
                                  </div>
                                </div>
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "context"}>
                            <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <SessionContextTab />
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "tools"}>
                            <Tabs.Content value="tools" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <SessionToolsTab onSelectCheckpoint={props.onSelectCheckpoint} />
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeFileTab()} keyed>
                            {(tab) => <FileTabContent tab={tab} />}
                          </Show>
                        </Tabs>
                        <DragOverlay>
                          <Show when={store.activeDraggable} keyed>
                            {(tab) => {
                              const path = file.pathFromTab(tab)
                              return (
                                <div data-component="tabs-drag-preview">
                                  <Show when={path}>
                                    {(p) => <FileVisual active path={p()} temporary={temporaryTab() === tab} />}
                                  </Show>
                                </div>
                              )
                            }}
                          </Show>
                        </DragOverlay>
                      </DragDropProvider>
                    }
                  >
                    <DndKitProvider
                      sensors={[
                        PointerSensor.configure({
                          activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                          preventActivation: (event) =>
                            event.target instanceof Element &&
                            (!!event.target.closest('[data-slot="tabs-trigger-close-button"]') ||
                              !!event.target.closest(".session-review-v2-open-in-app-slot")),
                        }),
                      ]}
                      modifiers={[
                        RestrictToHorizontalAxis,
                        RestrictToElement.configure({ element: () => tabList ?? null }),
                      ]}
                      plugins={(defaults) => [
                        ...defaults.filter((plugin) => plugin !== Accessibility),
                        AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
                        Feedback.configure({ dropAnimation: null }),
                      ]}
                      onDragEnd={(event) => {
                        const source = event.operation.source
                        if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
                        tabs().move(source.id.toString(), source.index)
                      }}
                    >
                      <Tabs value={activeTab()} onChange={activateTab}>
                        <div
                          class="session-review-v2-preview-toolbar sticky top-0 shrink-0 grid grid-cols-[auto_1fr_auto] items-center gap-3 h-10 pl-2 pr-3 border-b border-base"
                          classList={{
                            "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                            "bg-background-stronger": !settings.general.newLayoutDesigns(),
                          }}
                        >
                          <div class="flex items-center gap-0.5 min-w-0">
                            <Show when={props.panelSizeToggle} keyed>
                              {(toggle) => <>{toggle}</>}
                            </Show>
                            <div
                              ref={capsuleRef}
                              class="flex-none flex gap-1 items-center overflow-x-auto no-scrollbar border border-base bg-v2-background-bg-layer-03 rounded-full"
                            >
                              <TooltipV2 value={language.t("preview.title")} placement="bottom">
                                <button
                                  ref={previewButtonRef}
                                  type="button"
                                  class="shrink-0 flex items-center gap-1.5 h-7 px-2 rounded-full cursor-pointer transition-colors"
                                  classList={{
                                    "bg-v2-background-bg-layer-01 hover:bg-v2-overlay-simple-overlay-hover border border-[var(--v2-text-text-accent)]":
                                      activeTab() === "preview",
                                    "hover:bg-v2-overlay-simple-overlay-hover": activeTab() !== "preview",
                                  }}
                                  style={{
                                    color: activeTab() === "preview" ? "var(--v2-text-text-accent)" : undefined,
                                    background:
                                      activeTab() === "preview"
                                        ? "color-mix(in srgb, var(--v2-text-text-accent) 30%, transparent)"
                                        : undefined,
                                  }}
                                  onClick={() => activateTab("preview")}
                                  aria-label={language.t("preview.title")}
                                  aria-pressed={activeTab() === "preview"}
                                >
                                  <IconV2 name="globe" size="small" />
                                  <Show when={activeTab() === "preview"}>
                                    <span class="text-12-medium whitespace-nowrap">{language.t("preview.title")}</span>
                                  </Show>
                                </button>
                              </TooltipV2>
                              <For each={inlineHeaderActions()}>
                                {(action) => (
                                  <div class="flex shrink-0">
                                    <TooltipV2 value={action.aria()} placement="bottom">
                                      <button
                                        type="button"
                                        class="shrink-0 flex items-center gap-1.5 h-7 px-2 rounded-full cursor-pointer transition-colors"
                                        classList={{
                                          "bg-v2-background-bg-layer-01 hover:bg-v2-overlay-simple-overlay-hover border border-[var(--v2-text-text-accent)]":
                                            action.active(),
                                          "hover:bg-v2-overlay-simple-overlay-hover": !action.active(),
                                        }}
                                        style={{
                                          color: action.active() ? "var(--v2-text-text-accent)" : undefined,
                                          background: action.active()
                                            ? "color-mix(in srgb, var(--v2-text-text-accent) 30%, transparent)"
                                            : undefined,
                                        }}
                                        onClick={action.onClick}
                                        aria-label={action.aria()}
                                        aria-pressed={action.active()}
                                      >
                                        {action.icon}
                                        <Show when={action.active()}>
                                          <span class="text-12-medium whitespace-nowrap">{action.label()}</span>
                                        </Show>
                                      </button>
                                    </TooltipV2>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>

                          <Show when={activeTab() === "preview"}>
                            <div class="flex items-center justify-center gap-2 min-w-0">
                              <TooltipV2 value={deviceLabel()} placement="bottom">
                                <button
                                  type="button"
                                  class="flex items-center justify-center h-8 w-8 rounded-md cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                                  onClick={() => cycleDevice()}
                                  aria-label={deviceLabel()}
                                >
                                  <Switch fallback={<IconV2 name="monitor" size="small" />}>
                                    <Match when={device() === "tablet"}>
                                      <IconV2 name="tablet" size="small" />
                                    </Match>
                                    <Match when={device() === "mobile"}>
                                      <IconV2 name="mobile" size="small" />
                                    </Match>
                                  </Switch>
                                </button>
                              </TooltipV2>

                              <div class="flex items-center gap-0.5 px-1.5 h-8 rounded-full border border-base min-w-[100px] w-[min(220px,18vw)] focus-within:border-border-strong">
                                <IconButtonV2
                                  icon={<Icon name="refresh" size="small" />}
                                  variant="ghost-muted"
                                  size="small"
                                  class="hover:bg-transparent"
                                  onClick={() => previewControl.reload(activeRoute())}
                                  aria-label={language.t("preview.action.reloadPreview")}
                                />
                                <MenuV2
                                  gutter={4}
                                  modal={false}
                                  placement="bottom"
                                  onOpenChange={(open) => {
                                    if (!open) setRouteSearch("")
                                    else queueMicrotask(() => routeSearchRef?.focus())
                                  }}
                                >
                                  <MenuV2.Trigger as="div" class="flex-1 min-w-0">
                                    <div class="flex items-center justify-center gap-1.5 text-center w-full min-w-0 h-full cursor-pointer select-none">
                                      <span class="truncate text-12-regular text-text-strong">{routeLabel()}</span>
                                      <Icon name="chevron-down" size="small" />
                                    </div>
                                  </MenuV2.Trigger>
                                  <MenuV2.Portal>
                                    <MenuV2.Content class="address-menu w-64">
                                      <div class="address-menu-search flex items-center gap-1.5 px-2 py-1.5 border-b border-border-base">
                                        <IconV2 name="magnifying-glass" size="small" class="shrink-0" />
                                        <input
                                          ref={routeSearchRef}
                                          value={routeSearch()}
                                          onInput={(e) => setRouteSearch(e.currentTarget.value)}
                                          onKeyDown={(e) => {
                                            e.stopPropagation()
                                            if (e.key === "Enter" && searchPath()) navigateRoute(searchPath())
                                          }}
                                          placeholder="/about"
                                          spellcheck={false}
                                          class="w-full min-w-0 bg-transparent border-0 outline-none text-12-regular text-text-strong placeholder:text-text-faint"
                                        />
                                      </div>
                                      <div class="mt-1 max-h-56 overflow-y-auto">
                                        <For each={addressPages()}>
                                          {(page) => (
                                            <MenuV2.Item onSelect={() => navigateRoute(page.route)}>
                                              <span class="truncate flex-1 font-mono text-12-regular text-text-strong">
                                                {page.route === "/" ? "Homepage" : page.route}
                                              </span>
                                              <Show when={activeRoute() === page.route}>
                                                <IconV2 name="check" size="small" />
                                              </Show>
                                            </MenuV2.Item>
                                          )}
                                        </For>
                                        <Show when={searchPath()}>
                                          <MenuV2.Item onSelect={() => navigateRoute(searchPath())}>
                                            <IconV2 name="code" size="small" />
                                            <span class="truncate">
                                              Go to <span class="font-mono">{searchPath()}</span>
                                            </span>
                                          </MenuV2.Item>
                                        </Show>
                                      </div>
                                    </MenuV2.Content>
                                  </MenuV2.Portal>
                                </MenuV2>
                              </div>

                              <TooltipV2 value={language.t("preview.action.openInBrowser")} placement="bottom">
                                <IconButtonV2
                                  icon={<IconV2 name="outline-square-arrow" size="small" />}
                                  variant="ghost-muted"
                                  size="large"
                                  onClick={() => {
                                    const dir = projectDirectory()
                                    if (!dir) return
                                    import("@/context/preview-lifecycle").then(({ getPreviewUrl }) => {
                                      const url = getPreviewUrl(dir)
                                      if (url) window.open(url, "_blank")
                                    })
                                  }}
                                  aria-label={language.t("preview.action.openInBrowser")}
                                />
                              </TooltipV2>
                              <VisualEditorToggle />
                              <div
                                class="shrink-0 flex items-center"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <OpenInAppV2 directory={projectDirectory} />
                              </div>
                              <SelectV2
                                appearance="inline"
                                aria-label={language.t("session.zoom")}
                                numeric
                                options={previewZoomOptions}
                                current={zoom()}
                                value={(v) => String(v)}
                                label={(v) => `${v}%`}
                                onSelect={(v) => {
                                  if (v != null) setZoom(v)
                                }}
                                valueClass="zoom-select"
                              />
                            </div>
                          </Show>
                          <Show when={activeTab() === "preview"}>
                            <div class="flex flex-1 items-center justify-end gap-2 min-w-0">
                              <TooltipV2 value={language.t("publish.button")} placement="bottom">
                                <button
                                  type="button"
                                  class="flex items-center gap-1.5 h-7 px-2 rounded-full cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover text-12-medium text-blue-500"
                                  onClick={() => dialog.show(() => <PublishDialog />)}
                                  aria-label={language.t("publish.button")}
                                >
                                  <Icon name="cloud-upload" size="small" />
                                  <span class="whitespace-nowrap">{language.t("publish.button")}</span>
                                </button>
                              </TooltipV2>
                            </div>
                          </Show>
                        </div>

                        <Show when={isCodeActive()}>
                          <div class="flex shrink-0 h-7 border-b border-base">
                            <Tabs.List
                              class="h-7"
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={props.reviewSidebarToggle}>
                                {(toggle) => (
                                  <div
                                    class="session-review-v2-sidebar-toggle-slot pr-1 shrink-0 sticky left-0 z-10 flex items-center justify-center"
                                    classList={{
                                      "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                                      "bg-background-stronger": !settings.general.newLayoutDesigns(),
                                    }}
                                  >
                                    {toggle()(activeTab() === SESSION_OPEN_FILE_TAB)}
                                  </div>
                                )}
                              </Show>
                              <For each={panelTabs()}>
                                {(tab) => (
                                  <Show
                                    when={tab === SESSION_OPEN_FILE_TAB}
                                    fallback={
                                      <Tabs.Trigger
                                        value={tab}
                                        class="h-6"
                                        closeButton={
                                          <TooltipKeybind
                                            title={language.t("common.closeTab")}
                                            keybind={command.keybind("tab.close")}
                                            placement="bottom"
                                            gutter={10}
                                          >
                                            <IconButton
                                              icon="close-small"
                                              variant="ghost"
                                              class="h-4 w-4"
                                              onClick={() => tabs().close(tab)}
                                              aria-label={language.t("common.closeTab")}
                                            />
                                          </TooltipKeybind>
                                        }
                                        hideCloseButton
                                        onMiddleClick={() => tabs().close(tab)}
                                        onDblClick={() => (temporaryTab() === tab ? openTab(tab) : undefined)}
                                      >
                                        <Show when={file.pathFromTab(tab)}>
                                          {(path) => <FileVisual path={path()} temporary={temporaryTab() === tab} />}
                                        </Show>
                                      </Tabs.Trigger>
                                    }
                                  >
                                    <Tabs.Trigger
                                      value={SESSION_OPEN_FILE_TAB}
                                      closeButton={
                                        <TooltipKeybind
                                          title={language.t("common.closeTab")}
                                          keybind={command.keybind("tab.close")}
                                          placement="bottom"
                                          gutter={10}
                                        >
                                          <IconButton
                                            icon="close-small"
                                            variant="ghost"
                                            class="h-4 w-4"
                                            onClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                            aria-label={language.t("common.closeTab")}
                                          />
                                        </TooltipKeybind>
                                      }
                                      hideCloseButton
                                      onMiddleClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                    >
                                      <div class="flex items-center gap-1.5 italic">
                                        <Icon name="open-file" size="small" />
                                        <span>{language.t("command.file.open")}</span>
                                      </div>
                                    </Tabs.Trigger>
                                  </Show>
                                )}
                              </For>
                              <Show when={contextOpen()}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <div
                                class="h-full shrink-0 sticky -right-3 z-10 flex items-center justify-center pr-3"
                                classList={{
                                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                                  "bg-background-stronger": !settings.general.newLayoutDesigns(),
                                }}
                              >
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={openFileBrowser}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </div>
                        </Show>

                        <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                          <div
                            id={reviewTabPanelID}
                            role="tabpanel"
                            aria-labelledby={reviewTabID}
                            tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                            data-slot="tabs-content"
                            class="flex flex-col h-full overflow-hidden contain-strict"
                          >
                            {props.reviewPanel()}
                          </div>
                        </Show>

                        <div
                          class="flex flex-col h-full overflow-hidden"
                          classList={{ "absolute inset-0 pointer-events-none opacity-0": activeTab() !== "preview" }}
                        >
                          <PreviewPanel
                            nonce={previewNonce()}
                            reloadKey={previewReloadKey()}
                            isResizing={props.size.active()}
                            onPreviewReady={props.onPreviewReady}
                            questionRequest={props.questionRequest}
                            onQuestionDone={props.onQuestionDone}
                            agentName={props.agentName}
                            deviceWidth={deviceWidth()}
                            zoom={device() === "desktop" ? zoom() / 100 : 1}
                            onUrlChange={handleUrlChange}
                            control={previewControl}
                          />
                        </div>

                        <Show when={activeTab() === "empty" && !fileBrowserMounted()}>
                          <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                <BrandLogo size="medium" class="opacity-10" />
                                <div class="text-14-regular text-text-weak max-w-56">
                                  {language.t("session.files.selectToOpen")}
                                </div>
                              </div>
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "context"}>
                          <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "tools"}>
                          <Tabs.Content value="tools" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionToolsTab onSelectCheckpoint={props.onSelectCheckpoint} />
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={fileBrowserMounted()}>
                          <div
                            id={fileBrowserTabPanelID}
                            role="tabpanel"
                            data-slot="tabs-content"
                            class="h-full min-h-0 overflow-hidden"
                            classList={{ hidden: !fileBrowserVisible() }}
                            inert={!fileBrowserVisible() || undefined}
                          >
                            <SessionFileBrowserTab
                              tab={browserTab() ?? activeFileTab() ?? SESSION_OPEN_FILE_TAB}
                              placeholder={
                                (browserTab() ?? activeFileTab() ?? SESSION_OPEN_FILE_TAB) === SESSION_OPEN_FILE_TAB
                              }
                              active={file.pathFromTab(browserTab() ?? activeFileTab() ?? "")}
                              kinds={kinds()}
                              state={props.fileBrowserState!}
                              diff={browserDiff()}
                              diffVersion={browserSource() === "git" ? props.diffVersion : undefined}
                              loadDiff={browserSource() === "git" ? props.loadDiff : undefined}
                              expandUnchanged={browserSource() === "git" ? props.expandUnchanged : undefined}
                              sidebarOpen={browserSource() === "tree" ? false : undefined}
                              onSelect={(path) => {
                                const tab = file.tab(path)
                                props.setFileTabSource?.(tab, "code")
                                openTab(tab)
                              }}
                              onSelectPermanent={(path) => {
                                const tab = file.tab(path)
                                props.setFileTabSource?.(tab, "code")
                                openTab(tab)
                              }}
                              filterRef={(element) => (fileFilter = element)}
                            />
                          </div>
                        </Show>
                      </Tabs>
                    </DndKitProvider>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={fileOpen() && !props.hideFileTree}>
              <div
                id="file-tree-panel"
                class="relative shrink-0 h-full bg-v2-background-bg-base flex flex-col min-h-0 overflow-hidden rounded-xl border border-border-weak-base ml-2"
                classList={{
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div class="flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden">
                  <div class="flex justify-center py-1.5 text-13-medium text-text-base border-b border-border-weaker-base shrink-0">
                    {language.t("session.files.all")}
                  </div>
                  <div class="flex-1 min-h-0 overflow-y-auto">
                    <div class="px-3 py-0">
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            root={{ name: projectName(), zip: `${projectName()}.zip` }}
                            onFileClick={(node) => {
                              const tab = file.tab(node.path)
                              props.setFileTabSource?.(tab, "tree")
                              openTab(tab)
                            }}
                            onDownloadProject={downloadProject}
                            onRename={async (oldPath: string, newPath: string) => {
                              try {
                                await fetch(`${sdk().url}/file/rename`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ directory: projectDirectory(), oldPath, newPath }),
                                })
                                file.tree.refresh("")
                              } catch {}
                            }}
                            onDelete={async (path: string) => {
                              try {
                                await fetch(`${sdk().url}/file/remove`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ directory: projectDirectory(), path }),
                                })
                                file.tree.refresh("")
                              } catch {}
                            }}
                          />
                        </Match>
                      </Switch>
                    </div>
                  </div>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={layout.fileTree.width()}
                      min={200}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
      <style>{`
        [data-component="menu-v2-content"].address-menu {
          padding: 6px;
          border-radius: 14px;
          border: 1px solid var(--v2-border-border-base);
          background: var(--v2-background-bg-layer-01);
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), var(--v2-elevation-floating);
          overflow: hidden;
          margin-top: 6px;
        }
        [data-component="menu-v2-content"].address-menu [data-component="menu-v2-item"] {
          height: 34px;
          padding: 0 10px;
          border-radius: 9px;
          gap: 10px;
          margin: 1px 0;
        }
        [data-component="menu-v2-content"].address-menu [data-component="menu-v2-item"]:hover,
        [data-component="menu-v2-content"].address-menu [data-component="menu-v2-item"][data-highlighted] {
          background: var(--v2-overlay-simple-overlay-hover);
        }
        [data-component="menu-v2-content"].address-menu .address-menu-search {
          margin: -6px -6px 4px;
          padding: 10px 12px;
        }
      `}</style>
    </Show>
  )
}
