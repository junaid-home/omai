import { createSignal, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { AuthHead, AuthSurface } from "@/components/auth-surface"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"
// Needed again when the Google sign-in button below is uncommented.
// import { centralRuntime } from "@/utils/central-state"

export default function LoginPage() {
  const auth = useAuth()
  const language = useLanguage()
  const navigate = useNavigate()
  const [identifier, setIdentifier] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [revealPassword, setRevealPassword] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  onMount(() => {
    const code = new URLSearchParams(window.location.search).get("error")
    if (code) {
      setError(googleErrorMessage(language, code))
      history.replaceState(null, "", window.location.pathname)
    }
  })

  // Google sign-in is temporarily hidden. Restore by uncommenting the button
  // below together with its divider and the signInWithGoogle helper.
  //
  // const signInWithGoogle = () => {
  //   const base = centralRuntime.get().url ?? window.location.origin
  //   window.location.href = `${base.replace(/\/+$/, "")}/auth/google`
  // }

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    if (!identifier() || !password()) {
      setError(language.t("auth.login.error.required"))
      return
    }
    setLoading(true)
    setError("")
    const result = await auth.login(identifier(), password())
    setLoading(false)
    if (result.error) {
      setError(result.error)
    } else {
      navigate("/")
    }
  }

  return (
    <AuthSurface>
      <AuthHead
        eyebrow={language.t("auth.login.eyebrow")}
        title={language.t("auth.login.title")}
        subtitle={language.t("auth.login.subtitle")}
      />

      {error() && (
        <div role="alert" class="auth-error">
          {error()}
        </div>
      )}

      {/* Google sign-in — uncomment to re-enable.
      <Button variant="secondary" size="large" class="w-full" onClick={signInWithGoogle}>
        <span class="flex w-full items-center justify-center gap-2.5">
          <svg viewBox="0 0 48 48" aria-hidden="true" class="size-4 shrink-0">
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
          {language.t("auth.login.continueWithGoogle")}
        </span>
      </Button>

      <div class="auth-divider" aria-hidden="true">
        <span class="auth-divider-line" />
        <span class="auth-divider-label">{language.t("auth.login.or")}</span>
        <span class="auth-divider-line" />
      </div>
      */}

      <form onSubmit={handleSubmit} class="auth-form">
        <div class="auth-field">
          <TextField
            label={language.t("auth.login.username.label")}
            placeholder={language.t("auth.login.username.placeholder")}
            value={identifier()}
            onChange={(v) => {
              setIdentifier(v)
              setError("")
            }}
          />
          <Icon name="user" class="auth-field-icon" />
        </div>
        <div class="auth-password">
          <TextField
            label={language.t("auth.login.password.label")}
            type={revealPassword() ? "text" : "password"}
            placeholder={language.t("auth.login.password.placeholder")}
            value={password()}
            onChange={(v) => {
              setPassword(v)
              setError("")
            }}
          />
          <IconButton
            type="button"
            class="auth-password-toggle"
            icon="eye"
            variant="ghost"
            aria-label={
              revealPassword() ? language.t("auth.login.password.hide") : language.t("auth.login.password.show")
            }
            aria-pressed={revealPassword()}
            onClick={() => setRevealPassword(!revealPassword())}
          />
        </div>
        <Button type="submit" variant="primary" size="large" class="auth-submit" disabled={loading()}>
          <span class="auth-submit-inner">
            {loading() ? language.t("auth.login.submitting") : language.t("auth.login.submit")}
            <Icon name="arrow-right" class="auth-submit-icon" />
          </span>
        </Button>
      </form>
    </AuthSurface>
  )
}

function googleErrorMessage(language: ReturnType<typeof useLanguage>, code: string) {
  if (code === "google_denied") return language.t("auth.login.error.google_denied")
  if (code === "google_state") return language.t("auth.login.error.google_state")
  if (code === "google_email") return language.t("auth.login.error.google_email")
  if (code === "google_unavailable") return language.t("auth.login.error.google_unavailable")
  return language.t("auth.login.error.google_exchange")
}
