let invitation: string | undefined

/** Fragments stay out of HTTP requests; remove the invitation before rendering or telemetry. */
export function captureSignupInvitation(input: { url: string; replace: (url: string) => void }) {
  invitation = undefined
  const url = new URL(input.url)
  if (url.pathname !== "/signup-secret-route") return
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (!fragment.has("invite")) return
  const values = fragment.getAll("invite")
  fragment.delete("invite")
  url.hash = fragment.toString()
  input.replace(url.toString())
  const value = values[0]
  if (values.length !== 1 || !value || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) return
  invitation = value
}

// Keep the invitation only in this document so a failed signup can be retried.
export const signupInvitation = () => invitation
