import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type {
  GitBranchesResponse,
  GitCommitResponse,
  GitInfoResponse,
  GitLogResponse,
  VcsStatusResponse,
} from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"
import "./session-git-tab.css"

const PAGE_SIZE = 20

type FileStatus = VcsStatusResponse[number]
type Branch = GitBranchesResponse[number]
type Commit = GitLogResponse[number]
type Remote = GitInfoResponse["remotes"][number]
type Summary = GitInfoResponse

const errorMessage = (err: unknown) => {
  const value = err as { message?: string; data?: { message?: string } } | null | undefined
  return value?.data?.message || value?.message || ""
}

const count = (value: string | number | undefined) => (typeof value === "number" && value > 0 ? value : 0)

const statusLabel = (status: FileStatus["status"]) => {
  if (status === "added") return "git.changes.status.added"
  if (status === "deleted") return "git.changes.status.deleted"
  return "git.changes.status.modified"
}

const statusTone = (status: FileStatus["status"]) => {
  switch (status) {
    case "added":
      return "session-git-tab-status-added"
    case "deleted":
      return "session-git-tab-status-deleted"
    default:
      return "session-git-tab-status-modified"
  }
}

const statusLetter = (status: FileStatus["status"]) => {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

const validRemoteUrl = (value: string) =>
  /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/.test(value) || value.startsWith("/") || value.startsWith(".")

export function SessionGitTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()

  const [state, setState] = createStore({
    loading: true,
    refreshing: false,
    info: undefined as Summary | undefined,
    files: [] as FileStatus[],
    branches: [] as Branch[],
    commits: [] as Commit[],
    remotes: [] as Remote[],
    limit: PAGE_SIZE,
    message: "",
    branchInput: "",
    creating: false,
    switching: "",
    committing: false,
    pushing: false,
    pulling: false,
    discarding: "",
    savingRemote: "",
  })

  const client = () => sdk().client

  const syncRemote = () => state.remotes.find((item) => item.name === "origin")?.name ?? state.remotes[0]?.name

  const load = async (options?: { quiet?: boolean }) => {
    if (options?.quiet) setState("refreshing", true)
    else setState("loading", true)
    try {
      const [info, status] = await Promise.all([client().git.info(), client().vcs.status()])
      setState("info", info.data!)
      setState("files", status.data ?? [])
      setState("remotes", info.data!.remotes ?? [])
      if (!info.data!.initialized) {
        setState({ branches: [], commits: [] })
        return
      }
      const [branches, log] = await Promise.all([
        client().git.branches(),
        client().git.log({ limit: String(state.limit) }),
      ])
      setState("branches", branches.data ?? [])
      setState("commits", log.data ?? [])
    } catch (err) {
      setState({ info: undefined, files: [], branches: [], commits: [], remotes: [] })
      if (!options?.quiet) showToast({ title: errorMessage(err) || language.t("git.load.failed"), variant: "error" })
    } finally {
      setState({ loading: false, refreshing: false })
    }
  }

  onMount(() => void load())

  let pending = false
  let inflight = false
  const refresh = async () => {
    if (inflight) {
      pending = true
      return
    }
    inflight = true
    try {
      await load({ quiet: true })
    } finally {
      inflight = false
      if (!pending) return
      pending = false
      void refresh()
    }
  }

  createEffect(() => {
    const off = sdk().event.on("vcs.changed", refresh)
    onCleanup(off)
  })

  const run = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action()
    } catch (err) {
      showToast({ title: errorMessage(err) || fallback, variant: "error" })
      await load({ quiet: true })
    }
  }

  const commit = (andPush: boolean) => {
    const message = state.message.trim()
    if (!message) return showToast({ title: language.t("git.commit.empty"), variant: "error" })
    if (state.files.length === 0) return showToast({ title: language.t("git.commit.nothing"), variant: "error" })
    const remote = syncRemote()
    if (andPush && !remote) return showToast({ title: language.t("git.sync.none"), variant: "error" })
    setState({ committing: true, pushing: andPush })
    return run(async () => {
      const result = await client().git.commit({ message })
      setState("message", "")
      if (andPush) {
        await client().git.push({ remote, setUpstream: true })
        showToast({ title: language.t("git.commit.push.success", { short: result.data!.short }) })
      } else {
        showToast({ title: language.t("git.commit.success", { short: result.data!.short }) })
      }
      await load({ quiet: true })
    }, language.t("git.commit.failed")).finally(() => setState({ committing: false, pushing: false }))
  }

  const push = () => {
    const remote = syncRemote()
    if (!remote) return
    setState("pushing", true)
    return run(async () => {
      await client().git.push({ remote, setUpstream: true })
      showToast({ title: language.t("git.sync.push.success", { remote }) })
      await load({ quiet: true })
    }, language.t("git.sync.push.failed")).finally(() => setState("pushing", false))
  }

  const pull = () => {
    setState("pulling", true)
    return run(async () => {
      await client().git.pull({ rebase: true })
      showToast({ title: language.t("git.sync.pull.success", { remote: syncRemote() ?? "origin" }) })
      await load({ quiet: true })
    }, language.t("git.sync.pull.failed")).finally(() => setState("pulling", false))
  }

  const checkout = (name: string) => {
    if (name === state.info?.branch) return
    setState("switching", name)
    return run(async () => {
      await client().git.checkout({ name })
      await load({ quiet: true })
    }, language.t("git.branches.switch.failed")).finally(() => setState("switching", ""))
  }

  const createBranch = () => {
    const name = state.branchInput.trim()
    if (!name) return
    setState("creating", true)
    return run(async () => {
      await client().git.createBranch({ name, from: state.info?.branch })
      setState("branchInput", "")
      showToast({ title: language.t("git.branches.create.success", { branch: name }) })
      await load({ quiet: true })
    }, language.t("git.branches.create.failed")).finally(() => setState("creating", false))
  }

  const confirmDeleteBranch = (name: string) => {
    dialog.show(() => <DeleteBranchDialog name={name} onDone={() => load({ quiet: true })} />)
  }

  const editRemote = (remote?: Remote) => {
    dialog.show(() => (
      <RemoteDialog
        remote={remote}
        names={state.remotes.map((item) => item.name)}
        onDone={() => load({ quiet: true })}
      />
    ))
  }

  const confirmRemoveRemote = (remote: Remote) => {
    dialog.show(() => <RemoveRemoteDialog remote={remote} onDone={() => load({ quiet: true })} />)
  }

  const discard = (files: string[]) => {
    const affected = files.length || state.files.length
    dialog.show(() => (
      <Dialog size="normal" title={language.t("git.discard.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("git.discard.confirm", { count: affected })}
            </span>
            <span class="text-13-regular text-text-muted leading-relaxed">{language.t("git.discard.hint")}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
              onClick={() => {
                dialog.close()
                setState("discarding", String(affected))
                void run(async () => {
                  await client().git.discard({ files })
                  showToast({ title: language.t("git.discard.success") })
                  await load({ quiet: true })
                }, language.t("git.discard.failed")).finally(() => setState("discarding", ""))
              }}
            >
              {language.t("git.discard.action")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const loadMore = () => {
    setState("limit", state.limit + PAGE_SIZE)
    return run(async () => {
      const log = await client().git.log({ limit: String(state.limit) })
      setState("commits", log.data ?? [])
    }, language.t("git.load.failed"))
  }

  const busy = () =>
    state.committing ||
    state.pushing ||
    state.pulling ||
    state.creating ||
    state.switching !== "" ||
    state.discarding !== "" ||
    state.savingRemote !== ""

  return (
    <ScrollView class="session-git-tab">
      <div class="session-git-tab-content">
        <Show when={state.loading}>
          <div class="session-git-tab-loading">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-v2-border-border-strong border-t-transparent" />
            {language.t("git.loading")}
          </div>
        </Show>

        <Show when={!state.loading && state.info && !state.info.initialized}>
          <div class="session-git-tab-empty">
            <Icon name="warning" size="large" />
            <div class="text-13-medium text-v2-text-text-base">{language.t("git.notGit.title")}</div>
            <div class="text-12-regular">{language.t("git.notGit.description")}</div>
          </div>
        </Show>

        <Show when={!state.loading && state.info?.initialized}>
          <div class="session-git-tab-summary">
            <Icon name="branch" size="small" class="shrink-0 text-v2-text-text-muted" />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex min-w-0 items-center gap-2">
                <span class="session-git-tab-branch">{state.info?.branch ?? "-"}</span>
                <Show when={count(state.info?.ahead) > 0}>
                  <span class="session-git-tab-chip">
                    {language.t("git.branches.ahead", { count: count(state.info?.ahead) })}
                  </span>
                </Show>
                <Show when={count(state.info?.behind) > 0}>
                  <span class="session-git-tab-chip">
                    {language.t("git.branches.behind", { count: count(state.info?.behind) })}
                  </span>
                </Show>
              </div>
              <div class="truncate text-11-regular text-v2-text-text-muted">
                <Show when={state.info?.upstream} fallback={<span>{language.t("git.sync.none")}</span>}>
                  {(upstream) => (
                    <span>
                      {language.t("git.branches.tracking", { upstream: upstream() })}
                      {count(state.info?.ahead) === 0 && count(state.info?.behind) === 0
                        ? ` · ${language.t("git.sync.upToDate")}`
                        : ""}
                    </span>
                  )}
                </Show>
              </div>
            </div>
            <Show when={syncRemote()}>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="small"
                  icon="arrow-down-to-line"
                  disabled={busy()}
                  onClick={pull}
                  title={language.t("git.sync.pull")}
                >
                  {state.pulling ? language.t("git.sync.pulling") : language.t("git.sync.pull")}
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  icon="arrow-up"
                  disabled={busy()}
                  onClick={push}
                  title={language.t("git.sync.push")}
                >
                  {state.pushing ? language.t("git.sync.pushing") : language.t("git.sync.push")}
                </Button>
              </div>
            </Show>
            <IconButton
              name="refresh"
              label={state.refreshing ? language.t("git.refreshing") : language.t("git.refresh")}
              spinning={state.refreshing}
              disabled={busy()}
              onClick={() => load({ quiet: true })}
            />
          </div>

          <div class="session-git-tab-group">
            <div class="session-git-tab-group-head">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("git.changes.title")}</span>
              <Show when={state.files.length > 0}>
                <span class="text-12-regular text-v2-text-text-faint">
                  {language.t("git.changes.count", { count: state.files.length })}
                </span>
              </Show>
              <div class="flex-1" />
              <Show when={state.files.length > 0}>
                <Button
                  variant="ghost"
                  size="small"
                  class="session-git-tab-danger"
                  disabled={busy()}
                  onClick={() => discard([])}
                >
                  {language.t("git.discard.action")}
                </Button>
              </Show>
            </div>

            <Show
              when={state.files.length > 0}
              fallback={
                <div class="session-git-tab-hint">
                  <span class="text-13-regular text-v2-text-text-base">{language.t("git.changes.empty")}</span>
                  <span class="text-12-regular text-v2-text-text-muted">{language.t("git.changes.empty.hint")}</span>
                </div>
              }
            >
              <For each={state.files}>
                {(file) => (
                  <div class="session-git-tab-row">
                    <span
                      class={`session-git-tab-status ${statusTone(file.status)}`}
                      title={language.t(statusLabel(file.status))}
                    >
                      {statusLetter(file.status)}
                    </span>
                    <span class="session-git-tab-file-name" title={file.file}>
                      {file.file}
                    </span>
                    <span class="session-git-tab-diff">
                      <span class="text-on-success-base">+{file.additions}</span>{" "}
                      <span class="text-on-critical-base">-{file.deletions}</span>
                    </span>
                    <span class="session-git-tab-row-action">
                      <IconButton
                        name="trash"
                        label={language.t("git.discard.action")}
                        disabled={busy()}
                        onClick={() => discard([file.file])}
                      />
                    </span>
                  </div>
                )}
              </For>
            </Show>

            <div class="session-git-tab-composer">
              <TextareaV2
                rows={2}
                placeholder={language.t("git.commit.placeholder")}
                value={state.message}
                disabled={busy()}
                aria-label={language.t("git.commit.action")}
                onInput={(event) => setState("message", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void commit(false)
                  }
                }}
              />
              <div class="session-git-tab-composer-foot">
                <span class="session-git-tab-hint-text">{language.t("git.commit.hint")}</span>
                <div class="flex items-center gap-2">
                  <Button variant="secondary" size="small" disabled={busy()} onClick={() => commit(false)}>
                    <Show when={state.committing && !state.pushing}>
                      <span class="session-git-tab-spinner" />
                    </Show>
                    {language.t("git.commit.action")}
                  </Button>
                  <Show when={syncRemote()}>
                    <Button
                      variant="primary"
                      size="small"
                      icon="arrow-up"
                      disabled={busy()}
                      onClick={() => commit(true)}
                    >
                      {language.t("git.commit.actionAndPush")}
                    </Button>
                  </Show>
                </div>
              </div>
            </div>
          </div>

          <div class="session-git-tab-group">
            <div class="session-git-tab-group-head">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("git.remotes.title")}</span>
              <Show when={state.remotes.length > 0}>
                <span class="text-12-regular text-v2-text-text-faint">
                  {language.t("git.changes.count", { count: state.remotes.length })}
                </span>
              </Show>
              <div class="flex-1" />
              <Button variant="ghost" size="small" icon="plus-small" disabled={busy()} onClick={() => editRemote()}>
                {language.t("git.remotes.add.action")}
              </Button>
            </div>

            <Show
              when={state.remotes.length > 0}
              fallback={
                <div class="session-git-tab-hint">
                  <span class="text-13-regular text-v2-text-text-base">{language.t("git.remotes.none")}</span>
                  <span class="text-12-regular text-v2-text-text-muted">{language.t("git.remotes.hint")}</span>
                </div>
              }
            >
              <For each={state.remotes}>
                {(remote) => (
                  <div class="session-git-tab-row">
                    <Icon name="link" size="small" class="shrink-0 text-v2-text-text-faint" />
                    <div class="flex min-w-0 flex-1 flex-col">
                      <div class="flex min-w-0 items-center gap-2">
                        <span class="session-git-tab-remote-name">{remote.name}</span>
                        <Show when={remote.name === syncRemote()}>
                          <span class="session-git-tab-chip session-git-tab-chip-active">
                            {language.t("git.remotes.sync")}
                          </span>
                        </Show>
                      </div>
                      <span class="session-git-tab-remote-url" title={remote.url}>
                        {remote.url}
                      </span>
                    </div>
                    <span class="session-git-tab-row-actions">
                      <IconButton
                        name="edit"
                        label={language.t("git.remotes.edit.action")}
                        disabled={busy()}
                        onClick={() => editRemote(remote)}
                      />
                      <IconButton
                        name="trash"
                        label={language.t("git.remotes.remove.action")}
                        disabled={busy()}
                        onClick={() => confirmRemoveRemote(remote)}
                      />
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="session-git-tab-group">
            <div class="session-git-tab-group-head">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("git.branches.title")}</span>
              <Show when={state.branches.length > 0}>
                <span class="text-12-regular text-v2-text-text-faint">
                  {language.t("git.changes.count", { count: state.branches.length })}
                </span>
              </Show>
            </div>
            <div class="session-git-tab-create-row">
              <TextInputV2
                appearance="large"
                placeholder={language.t("git.branches.create.placeholder")}
                value={state.branchInput}
                disabled={busy()}
                aria-label={language.t("git.branches.create.action")}
                onInput={(event) => setState("branchInput", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createBranch()
                }}
              />
              <Button
                variant="secondary"
                size="large"
                icon="plus-small"
                disabled={busy() || !state.branchInput.trim()}
                onClick={createBranch}
              >
                {language.t("git.branches.create.action")}
              </Button>
            </div>
            <Show
              when={state.branches.length > 0}
              fallback={
                <div class="py-1 text-13-regular text-v2-text-text-muted">{language.t("git.branches.none")}</div>
              }
            >
              <For each={state.branches}>
                {(branch) => (
                  <div class="session-git-tab-row">
                    <button
                      type="button"
                      class="session-git-tab-branch-button"
                      disabled={busy() || branch.current}
                      onClick={() => checkout(branch.name)}
                    >
                      <Icon
                        name={branch.current ? "check" : "branch"}
                        size="small"
                        class={branch.current ? "text-v2-text-text-strong" : "text-v2-text-text-muted"}
                      />
                      <span
                        class={`session-git-tab-branch ${branch.current ? "text-13-medium text-v2-text-text-strong" : "text-13-regular text-v2-text-text-muted"}`}
                      >
                        {branch.name}
                      </span>
                      <Show when={count(branch.ahead) > 0}>
                        <span class="session-git-tab-chip">
                          {language.t("git.branches.ahead", { count: count(branch.ahead) })}
                        </span>
                      </Show>
                      <Show when={count(branch.behind) > 0}>
                        <span class="session-git-tab-chip">
                          {language.t("git.branches.behind", { count: count(branch.behind) })}
                        </span>
                      </Show>
                      <Show when={state.switching === branch.name}>
                        <span class="h-3 w-3 animate-spin rounded-full border-2 border-v2-border-border-strong border-t-transparent" />
                      </Show>
                    </button>
                    <Show when={!branch.current}>
                      <span class="session-git-tab-row-action">
                        <IconButton
                          name="trash"
                          label={language.t("git.branches.delete.action")}
                          disabled={busy()}
                          onClick={() => confirmDeleteBranch(branch.name)}
                        />
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="session-git-tab-group">
            <div class="session-git-tab-group-head">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("git.history.title")}</span>
              <Show when={state.commits.length > 0}>
                <span class="text-12-regular text-v2-text-text-faint">
                  {language.t("git.history.showing", { count: state.commits.length })}
                </span>
              </Show>
              <div class="flex-1" />
              <Show when={state.commits.length >= state.limit}>
                <Button variant="ghost" size="small" disabled={busy()} onClick={loadMore}>
                  {language.t("git.history.loadMore")}
                </Button>
              </Show>
            </div>
            <Show
              when={state.commits.length > 0}
              fallback={
                <div class="py-1 text-13-regular text-v2-text-text-muted">{language.t("git.history.empty")}</div>
              }
            >
              <ol class="session-git-tab-timeline">
                <For each={state.commits}>
                  {(item) => (
                    <li class="session-git-tab-timeline-item">
                      <span class="session-git-tab-timeline-dot" />
                      <div class="session-git-tab-timeline-body">
                        <div class="session-git-tab-timeline-subject">{item.subject}</div>
                        <div class="session-git-tab-timeline-meta">
                          <span class="session-git-tab-hash">{item.short}</span>
                          <span class="truncate">{item.author}</span>
                          <span>{getRelativeTime(new Date(item.date).toISOString(), language.t)}</span>
                          <Show when={item.parents.length > 1}>
                            <span class="session-git-tab-chip">{language.t("git.history.merge")}</span>
                          </Show>
                        </div>
                        <Show when={item.body.trim().length > 0}>
                          <div class="session-git-tab-timeline-body-text">{item.body}</div>
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </div>
        </Show>
      </div>
    </ScrollView>
  )
}

function RemoteDialog(props: { remote?: Remote; names: string[]; onDone: () => Promise<void> }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [name, setName] = createSignal(props.remote?.name ?? "")
  const [url, setUrl] = createSignal(props.remote?.url ?? "")
  const [error, setError] = createSignal<{ field: "name" | "url"; key: string; vars?: Record<string, string> }>()
  const [busy, setBusy] = createSignal(false)

  const validate = () => {
    const next = name().trim()
    if (!next) return { field: "name", key: "git.remotes.name.required" } as const
    if (/\s/.test(next)) return { field: "name", key: "git.remotes.name.invalid" } as const
    if (!props.remote && props.names.includes(next))
      return { field: "name", key: "git.remotes.name.duplicate", vars: { name: next } } as const
    if (!url().trim()) return { field: "url", key: "git.remotes.url.required" } as const
    if (!validRemoteUrl(url().trim())) return { field: "url", key: "git.remotes.url.invalid" } as const
  }

  const submit = async () => {
    const problem = validate()
    if (problem) return setError(problem)
    setBusy(true)
    setError()
    try {
      if (props.remote) {
        await sdk().client.git.setRemote({ name: props.remote.name, url: url().trim() })
        showToast({ title: language.t("git.remotes.edit.success", { name: props.remote.name }) })
      } else {
        await sdk().client.git.addRemote({ name: name().trim(), url: url().trim() })
        showToast({ title: language.t("git.remotes.add.success", { name: name().trim() }) })
      }
      dialog.close()
      await props.onDone()
    } catch (err) {
      showToast({
        title: errorMessage(err) || language.t(props.remote ? "git.remotes.edit.failed" : "git.remotes.add.failed"),
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="normal"
      title={props.remote ? language.t("git.remotes.edit.title") : language.t("git.remotes.add.title")}
      fit
    >
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="text-13-regular text-text-muted leading-relaxed">
          {props.remote
            ? language.t("git.remotes.edit.hint", { name: props.remote.name })
            : language.t("git.remotes.add.hint")}
        </div>

        <Show
          when={!props.remote}
          fallback={
            <div class="session-git-tab-field">
              <span class="session-git-tab-field-label">{language.t("git.remotes.name.label")}</span>
              <div class="session-git-tab-field-static">{props.remote?.name}</div>
            </div>
          }
        >
          <div class="session-git-tab-field">
            <span class="session-git-tab-field-label">{language.t("git.remotes.name.label")}</span>
            <TextInputV2
              appearance="large"
              placeholder={language.t("git.remotes.name.placeholder")}
              value={name()}
              invalid={error()?.field === "name"}
              aria-label={language.t("git.remotes.name.label")}
              onInput={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit()
              }}
            />
            <Show when={error()?.field === "name"}>
              <span class="session-git-tab-field-error">{language.t(error()!.key, error()!.vars)}</span>
            </Show>
          </div>
        </Show>

        <div class="session-git-tab-field">
          <span class="session-git-tab-field-label">{language.t("git.remotes.url.label")}</span>
          <TextInputV2
            appearance="large"
            placeholder={language.t("git.remotes.url.placeholder")}
            value={url()}
            invalid={error()?.field === "url"}
            aria-label={language.t("git.remotes.url.label")}
            onInput={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit()
            }}
          />
          <Show when={error()?.field === "url"}>
            <span class="session-git-tab-field-error">{language.t(error()!.key, error()!.vars)}</span>
          </Show>
        </div>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={busy()} onClick={submit}>
            {props.remote ? language.t("common.save") : language.t("git.remotes.add.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function RemoveRemoteDialog(props: { remote: Remote; onDone: () => Promise<void> }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  return (
    <Dialog size="normal" title={language.t("git.remotes.remove.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("git.remotes.remove.confirm", { name: props.remote.name })}
          </span>
          <span class="text-13-regular text-text-muted leading-relaxed">{language.t("git.remotes.remove.hint")}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
            disabled={busy()}
            onClick={async () => {
              setBusy(true)
              try {
                await sdk().client.git.deleteRemote({ name: props.remote.name })
                dialog.close()
                showToast({ title: language.t("git.remotes.remove.success", { name: props.remote.name }) })
                await props.onDone()
              } catch (err) {
                showToast({
                  title: errorMessage(err) || language.t("git.remotes.remove.failed"),
                  variant: "error",
                })
              } finally {
                setBusy(false)
              }
            }}
          >
            {language.t("git.remotes.remove.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DeleteBranchDialog(props: { name: string; onDone: () => Promise<void> }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [force, setForce] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  return (
    <Dialog size="normal" title={language.t("git.branches.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("git.branches.delete.confirm", { branch: props.name })}
          </span>
          <span class="text-13-regular text-text-muted leading-relaxed">{language.t("git.branches.delete.hint")}</span>
        </div>
        <label class="flex items-center gap-2 text-13-regular text-text-muted">
          <input type="checkbox" checked={force()} onChange={(event) => setForce(event.currentTarget.checked)} />
          {language.t("git.branches.delete.force")}
        </label>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            class="bg-[#ff6b6b] hover:bg-[#ff4c4c] text-white"
            disabled={busy()}
            onClick={async () => {
              setBusy(true)
              try {
                await sdk().client.git.deleteBranch({ name: props.name, force: force() || undefined })
                dialog.close()
                showToast({ title: language.t("git.branches.delete.success", { branch: props.name }) })
                await props.onDone()
              } catch (err) {
                showToast({
                  title: errorMessage(err) || language.t("git.branches.delete.failed"),
                  variant: "error",
                })
              } finally {
                setBusy(false)
              }
            }}
          >
            {language.t("git.branches.delete.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function IconButton(props: {
  name: "refresh" | "trash" | "edit"
  label: string
  disabled?: boolean
  spinning?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="session-git-tab-icon-button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class={props.spinning ? "animate-spin" : ""} style={{ display: "inline-flex" }}>
        <Icon name={props.name} size="small" />
      </span>
    </button>
  )
}
