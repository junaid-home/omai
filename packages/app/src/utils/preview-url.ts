/** Hosted preview addresses must keep their separate security origin and capability query. */
export function previewUrl(value: string, applicationOrigin: string, central: boolean) {
  if (central) {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin === applicationOrigin ||
      url.username ||
      url.password
    ) {
      throw new Error("The preview must use a separate HTTP origin.")
    }
    return url.toString()
  }
  try {
    const url = new URL(value)
    const origin = new URL(applicationOrigin)
    if (url.origin !== origin.origin) {
      url.hostname = origin.hostname
      url.port = origin.port
      url.protocol = origin.protocol
    }
    return url.toString()
  } catch {
    return value
  }
}
