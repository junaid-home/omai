import { createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { AuthHead, AuthSurface } from "@/components/auth-surface"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"

export default function SignupPage() {
  const auth = useAuth()
  const language = useLanguage()
  const navigate = useNavigate()
  const [username, setUsername] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [confirmPassword, setConfirmPassword] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    setError("")

    if (!username() || !email() || !password()) {
      setError(language.t("auth.signup.error.required"))
      return
    }
    if (username().length < 3 || username().length > 30) {
      setError(language.t("auth.signup.error.usernameLength"))
      return
    }
    if (!email().includes("@")) {
      setError(language.t("auth.signup.error.emailInvalid"))
      return
    }
    if (password().length < 6) {
      setError(language.t("auth.signup.error.passwordLength"))
      return
    }
    if (password() !== confirmPassword()) {
      setError(language.t("auth.signup.error.passwordMismatch"))
      return
    }

    setLoading(true)
    const result = await auth.signup(username(), email(), password())
    setLoading(false)
    if (result.error) {
      setError(result.error)
    } else {
      navigate("/")
    }
  }

  return (
    <AuthSurface>
      <AuthHead title={language.t("auth.signup.title")} subtitle={language.t("auth.signup.subtitle")} />

      {error() && (
        <div role="alert" class="auth-error">
          {error()}
        </div>
      )}

      <form onSubmit={handleSubmit} class="flex flex-col gap-3">
        <TextField
          label={language.t("auth.signup.username.label")}
          placeholder={language.t("auth.signup.username.placeholder")}
          value={username()}
          onChange={(v) => {
            setUsername(v)
            setError("")
          }}
        />
        <TextField
          label={language.t("auth.signup.email.label")}
          type="email"
          placeholder={language.t("auth.signup.email.placeholder")}
          value={email()}
          onChange={(v) => {
            setEmail(v)
            setError("")
          }}
        />
        <TextField
          label={language.t("auth.signup.password.label")}
          type="password"
          placeholder="••••••••"
          value={password()}
          onChange={(v) => {
            setPassword(v)
            setError("")
          }}
        />
        <TextField
          label={language.t("auth.signup.confirmPassword.label")}
          type="password"
          placeholder="••••••••"
          value={confirmPassword()}
          onChange={(v) => {
            setConfirmPassword(v)
            setError("")
          }}
        />
        <Button type="submit" variant="primary" size="large" class="mt-1" disabled={loading()}>
          {loading() ? language.t("auth.signup.submitting") : language.t("auth.signup.submit")}
        </Button>
      </form>

      <p class="auth-switch">
        {language.t("auth.signup.hasAccount")}{" "}
        <a href="/login" class="auth-switch-link">
          {language.t("auth.signup.login")}
        </a>
      </p>
    </AuthSurface>
  )
}
