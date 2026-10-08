import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Component, For, Show, createEffect, createResource, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { centralRuntime, fullSettingsPermissions, type SettingsPermissionKey } from "@/utils/central-state"
import "./settings-v2.css"

type Role = "admin" | "member"

type AdminUser = {
  id: string
  username: string
  email: string
  role: Role
  settingsPermissions: Record<SettingsPermissionKey, boolean>
}

type Draft = {
  role: Role
  settingsPermissions: Record<SettingsPermissionKey, boolean>
}

const SCOPE_LABEL_KEYS: Record<SettingsPermissionKey, string> = {
  mcp: "settings.mcp.title",
  models: "settings.models.title",
  providers: "settings.providers.title",
  servers: "status.popover.tab.servers",
  shortcuts: "settings.tab.shortcuts",
  general: "settings.tab.general",
  terminal: "settings.general.row.terminalFont.title",
  fileTree: "settings.general.row.showFileTree.title",
}

type RoleOption = { id: Role; label: string }

type CreateField = "username" | "email" | "password"

// Mirrors the admin create contract on the server.
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_MIN = 12

const initial = (value: string) => value.trim().charAt(0).toUpperCase() || "?"

export const SettingsAdminV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const auth = useAuth()

  const baseUrl = () => (centralRuntime.get().mode === "central" ? centralRuntime.get().url : server.current?.http.url)

  const [users, setUsers] = createStore<AdminUser[]>([])
  const [drafts, setDrafts] = createStore<Record<string, Draft>>({})
  const [form, setForm] = createStore<{ username: string; email: string; password: string; role: Role }>({
    username: "",
    email: "",
    password: "",
    role: "member",
  })
  const [error, setError] = createSignal<string | undefined>()
  const [saving, setSaving] = createSignal<string | undefined>()
  const [attempted, setAttempted] = createSignal(false)
  const [formError, setFormError] = createSignal<string | undefined>()
  const [failures, setFailures] = createStore<{ username?: string; email?: string; password?: string }>({})

  const roleOptions = (): RoleOption[] => [
    { id: "member", label: language.t("settings.admin.role.member") },
    { id: "admin", label: language.t("settings.admin.role.admin") },
  ]

  const doFetch = async (path: string, init?: RequestInit) => {
    const url = baseUrl()
    if (!url) throw new Error("Server not available")
    const response = await fetch(`${url}${path}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      ...init,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.message ?? "Request failed")
    return response.json() as Promise<unknown>
  }

  const reload = async () => {
    const data = (await doFetch("/admin/users")) as AdminUser[]
    setUsers(reconcile(data))
    setDrafts(reconcile({}))
    return data
  }

  const [loaded] = createResource(() => (baseUrl() ? reload() : undefined))

  createEffect(() => {
    void loaded()
  })

  const run = async (key: string, action: () => Promise<unknown>, onError?: (message: string) => void) => {
    setSaving(key)
    setError(undefined)
    if (onError) setFormError(undefined)
    try {
      await action()
      return true
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : language.t("settings.admin.error")
      if (onError) onError(message)
      else setError(message)
      return false
    } finally {
      setSaving(undefined)
    }
  }

  const scopeLabel = (scope: SettingsPermissionKey) =>
    language.t(SCOPE_LABEL_KEYS[scope] as Parameters<typeof language.t>[0])

  const draftFor = (user: AdminUser): Draft =>
    drafts[user.id] ?? { role: user.role, settingsPermissions: user.settingsPermissions }

  const isDirty = (user: AdminUser) => {
    const draft = drafts[user.id]
    if (!draft) return false
    if (draft.role !== user.role) return true
    return (Object.keys(user.settingsPermissions) as SettingsPermissionKey[]).some(
      (scope) => draft.settingsPermissions[scope] !== user.settingsPermissions[scope],
    )
  }

  const ensureDraft = (user: AdminUser) => {
    if (drafts[user.id]) return
    setDrafts(user.id, { role: user.role, settingsPermissions: { ...user.settingsPermissions } })
  }

  const setDraftRole = (user: AdminUser, next: Role) => {
    if (next === "member" && user.id === auth.user()?.id) {
      setError(language.t("settings.admin.error.selfDemote"))
      return
    }
    setError(undefined)
    ensureDraft(user)
    setDrafts(user.id, "role", next)
  }

  const setDraftScope = (user: AdminUser, scope: SettingsPermissionKey, allowed: boolean) => {
    ensureDraft(user)
    setDrafts(user.id, "settingsPermissions", scope, allowed)
  }

  const setDraftAll = (user: AdminUser, allowed: boolean) => {
    ensureDraft(user)
    for (const scope of Object.keys(user.settingsPermissions) as SettingsPermissionKey[]) {
      setDrafts(user.id, "settingsPermissions", scope, allowed)
    }
  }

  const discard = (user: AdminUser) => {
    setError(undefined)
    setDrafts(
      produce((d) => {
        delete d[user.id]
      }),
    )
  }

  const save = (user: AdminUser) => {
    const draft = drafts[user.id]
    if (!draft) return
    return run(user.id, async () => {
      const updated = (await doFetch(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: draft.role, settingsPermissions: draft.settingsPermissions }),
      })) as AdminUser
      setUsers((prev) => prev.map((x) => (x.id === user.id ? updated : x)))
      setDrafts(
        produce((d) => {
          delete d[user.id]
        }),
      )
    })
  }

  const validateUsername = (value: string) => {
    if (!value) return language.t("settings.admin.add.error.usernameMissing")
    if (!USERNAME_PATTERN.test(value)) return language.t("settings.admin.add.error.usernameInvalid")
    if (users.some((user) => user.username === value)) return language.t("settings.admin.add.error.usernameTaken")
    return undefined
  }

  const validateEmail = (value: string) => {
    if (!value || !EMAIL_PATTERN.test(value) || value.length > 254)
      return language.t("settings.admin.add.error.emailInvalid")
    if (users.some((user) => user.email === value)) return language.t("settings.admin.add.error.emailTaken")
    return undefined
  }

  const validatePassword = (value: string) =>
    value.length < PASSWORD_MIN ? language.t("settings.admin.add.error.passwordWeak") : undefined

  const fieldError = (field: CreateField) => {
    const server = failures[field]
    if (server) return server
    if (!attempted()) return undefined
    if (field === "username") return validateUsername(form.username.trim())
    if (field === "email") return validateEmail(form.email.trim().toLowerCase())
    return validatePassword(form.password)
  }

  const hasFieldError = () =>
    fieldError("username") !== undefined || fieldError("email") !== undefined || fieldError("password") !== undefined

  const canCreate = () =>
    form.username.trim().length > 0 && form.email.trim().length > 0 && form.password.length > 0 && !hasFieldError()

  const mapCreateFailure = (message: string): { field?: CreateField; message: string } => {
    const lower = message.toLowerCase()
    if (lower.includes("administrator")) return { message: language.t("settings.admin.add.error.forbidden") }
    if (lower.includes("password must"))
      return { field: "password", message: language.t("settings.admin.add.error.passwordWeak") }
    if (lower.includes("invalid email"))
      return { field: "email", message: language.t("settings.admin.add.error.emailInvalid") }
    if (lower.includes("username must"))
      return { field: "username", message: language.t("settings.admin.add.error.usernameInvalid") }
    if (lower.includes("already exists") || lower.includes("unique"))
      return { message: language.t("settings.admin.add.error.conflict") }
    return { message }
  }

  const create = () => {
    setAttempted(true)
    if (hasFieldError()) return
    return run(
      "__create__",
      async () => {
        const created = (await doFetch("/admin/users", {
          method: "POST",
          body: JSON.stringify({
            username: form.username.trim(),
            email: form.email.trim().toLowerCase(),
            password: form.password,
            role: form.role,
            settingsPermissions: fullSettingsPermissions(),
          }),
        })) as AdminUser
        setUsers((prev) => [...prev, created])
        setForm({ username: "", email: "", password: "", role: "member" })
        setFailures(reconcile({}))
        setFormError(undefined)
        setAttempted(false)
      },
      (message) => {
        const mapped = mapCreateFailure(message)
        if (mapped.field) setFailures(mapped.field, mapped.message)
        else setFormError(mapped.message)
      },
    )
  }

  const remove = (user: AdminUser) =>
    run(user.id, async () => {
      if (user.id === auth.user()?.id) {
        setError(language.t("settings.admin.error.selfDelete"))
        return
      }
      if (!window.confirm(language.t("settings.admin.delete.confirm", { username: user.username }))) return
      await doFetch(`/admin/users/${user.id}`, { method: "DELETE" })
      setUsers((prev) => prev.filter((x) => x.id !== user.id))
      setDrafts(
        produce((d) => {
          delete d[user.id]
        }),
      )
    })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.admin.title")}</h2>
      </div>

      <Show when={error()}>
        <div class="settings-v2-admin-error">{error()}</div>
      </Show>

      <div class="settings-v2-tab-body settings-v2-admin">
        <section class="settings-v2-section">
          <article class="settings-v2-admin-card">
            <header class="settings-v2-admin-section-head">
              <h3 class="settings-v2-section-title">{language.t("settings.admin.add.title")}</h3>
              <p class="settings-v2-admin-section-desc">{language.t("settings.admin.add.subtitle")}</p>
            </header>

            <div class="settings-v2-admin-create">
              <label class="settings-v2-admin-field">
                <span class="settings-v2-admin-field-label">{language.t("settings.admin.add.username")}</span>
                <TextInputV2
                  type="text"
                  appearance="base"
                  invalid={!!fieldError("username")}
                  value={form.username}
                  onInput={(event) => {
                    setForm("username", event.currentTarget.value)
                    setFailures("username", undefined)
                    setFormError(undefined)
                  }}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                />
                <Show
                  when={fieldError("username")}
                  fallback={
                    <span class="settings-v2-admin-field-hint">{language.t("settings.admin.add.hint.username")}</span>
                  }
                >
                  <span class="settings-v2-admin-field-error">{fieldError("username")}</span>
                </Show>
              </label>

              <label class="settings-v2-admin-field">
                <span class="settings-v2-admin-field-label">{language.t("settings.admin.add.email")}</span>
                <TextInputV2
                  type="email"
                  appearance="base"
                  invalid={!!fieldError("email")}
                  value={form.email}
                  onInput={(event) => {
                    setForm("email", event.currentTarget.value)
                    setFailures("email", undefined)
                    setFormError(undefined)
                  }}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                />
                <Show
                  when={fieldError("email")}
                  fallback={
                    <span class="settings-v2-admin-field-hint">{language.t("settings.admin.add.hint.email")}</span>
                  }
                >
                  <span class="settings-v2-admin-field-error">{fieldError("email")}</span>
                </Show>
              </label>

              <label class="settings-v2-admin-field">
                <span class="settings-v2-admin-field-label">{language.t("settings.admin.add.password")}</span>
                <TextInputV2
                  type="password"
                  appearance="base"
                  invalid={!!fieldError("password")}
                  value={form.password}
                  onInput={(event) => {
                    setForm("password", event.currentTarget.value)
                    setFailures("password", undefined)
                    setFormError(undefined)
                  }}
                  autocomplete="new-password"
                />
                <Show
                  when={fieldError("password")}
                  fallback={
                    <span class="settings-v2-admin-field-hint">{language.t("settings.admin.add.hint.password")}</span>
                  }
                >
                  <span class="settings-v2-admin-field-error">{fieldError("password")}</span>
                </Show>
              </label>

              <div class="settings-v2-admin-field">
                <span class="settings-v2-admin-field-label">{language.t("settings.admin.role")}</span>
                <SelectV2
                  appearance="base"
                  options={roleOptions()}
                  current={roleOptions().find((o) => o.id === form.role)}
                  value={(o) => o.id}
                  label={(o) => o.label}
                  onSelect={(option) => option && setForm("role", option.id)}
                  placement="bottom-start"
                  gutter={6}
                />
                <span class="settings-v2-admin-field-hint">{language.t("settings.admin.add.hint.role")}</span>
              </div>
            </div>

            <footer class="settings-v2-admin-card-foot">
              <div class="settings-v2-admin-create-status">
                <Show when={formError()}>
                  <span class="settings-v2-admin-form-error">{formError()}</span>
                </Show>
              </div>
              <ButtonV2
                variant="contrast"
                onClick={() => void create()}
                disabled={saving() !== undefined || !canCreate()}
              >
                {saving() === "__create__"
                  ? language.t("settings.admin.add.submitting")
                  : language.t("settings.admin.add.submit")}
              </ButtonV2>
            </footer>
          </article>
        </section>

        <section class="settings-v2-section">
          <header class="settings-v2-admin-section-head">
            <h3 class="settings-v2-section-title">{language.t("settings.admin.users.title")}</h3>
            <p class="settings-v2-admin-section-desc">{language.t("settings.admin.users.subtitle")}</p>
          </header>

          <Show
            when={!loaded.loading}
            fallback={
              <div class="settings-v2-admin-status">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <Show
              when={users.length > 0}
              fallback={<div class="settings-v2-admin-status">{language.t("settings.admin.users.empty")}</div>}
            >
              <For each={users}>
                {(user) => {
                  const isSelf = () => user.id === auth.user()?.id
                  const dirty = () => isDirty(user)
                  const savingThis = () => saving() === user.id
                  return (
                    <article class="settings-v2-admin-card" classList={{ "is-dirty": dirty() }}>
                      <header class="settings-v2-admin-card-head">
                        <div class="settings-v2-admin-identity">
                          <span class="settings-v2-admin-avatar" aria-hidden="true">
                            {initial(user.username)}
                          </span>
                          <div class="settings-v2-admin-identity-copy">
                            <div class="settings-v2-admin-identity-name">
                              {user.username}
                              <Show when={isSelf()}>
                                <span class="settings-v2-admin-badge">{language.t("settings.admin.you")}</span>
                              </Show>
                            </div>
                            <span class="settings-v2-admin-identity-email">{user.email}</span>
                          </div>
                        </div>
                        <div class="settings-v2-admin-card-actions">
                          <SelectV2
                            appearance="inline"
                            options={roleOptions()}
                            current={roleOptions().find((o) => o.id === draftFor(user).role)}
                            value={(o) => o.id}
                            label={(o) => o.label}
                            onSelect={(option) => option && setDraftRole(user, option.id)}
                            placement="bottom-end"
                            gutter={6}
                            disabled={isSelf()}
                          />
                          <ButtonV2
                            variant="danger"
                            size="small"
                            onClick={() => void remove(user)}
                            disabled={isSelf() || saving() !== undefined}
                          >
                            {language.t("settings.admin.delete")}
                          </ButtonV2>
                        </div>
                      </header>

                      <div class="settings-v2-admin-perms-head">
                        <span class="settings-v2-admin-perms-title">
                          {language.t("settings.admin.permissions.title")}
                        </span>
                        <span class="settings-v2-admin-perms-desc">
                          {language.t("settings.admin.permissions.subtitle")}
                        </span>
                      </div>

                      <div class="settings-v2-admin-perms">
                        <For each={Object.keys(user.settingsPermissions) as SettingsPermissionKey[]}>
                          {(scope) => (
                            <CheckboxV2
                              class="settings-v2-admin-perm"
                              checked={draftFor(user).settingsPermissions[scope]}
                              onChange={(checked) => setDraftScope(user, scope, checked)}
                              label={scopeLabel(scope)}
                            />
                          )}
                        </For>
                      </div>

                      <footer class="settings-v2-admin-card-foot">
                        <div class="settings-v2-admin-quick">
                          <ButtonV2
                            variant="ghost-muted"
                            size="small"
                            onClick={() => setDraftAll(user, true)}
                            disabled={saving() !== undefined}
                          >
                            {language.t("settings.admin.permissions.all")}
                          </ButtonV2>
                          <ButtonV2
                            variant="ghost-muted"
                            size="small"
                            onClick={() => setDraftAll(user, false)}
                            disabled={saving() !== undefined}
                          >
                            {language.t("settings.admin.permissions.none")}
                          </ButtonV2>
                        </div>
                        <div class="settings-v2-admin-save">
                          <Show when={dirty()}>
                            <span class="settings-v2-admin-unsaved">{language.t("settings.admin.unsaved")}</span>
                            <ButtonV2
                              variant="ghost-muted"
                              size="small"
                              onClick={() => discard(user)}
                              disabled={savingThis()}
                            >
                              {language.t("settings.admin.discard")}
                            </ButtonV2>
                          </Show>
                          <ButtonV2
                            variant="contrast"
                            size="small"
                            onClick={() => void save(user)}
                            disabled={!dirty() || saving() !== undefined}
                          >
                            {language.t("settings.admin.save")}
                          </ButtonV2>
                        </div>
                      </footer>
                    </article>
                  )
                }}
              </For>
            </Show>
          </Show>
        </section>
      </div>
    </>
  )
}
