export function sanitizeJson(value: string): string
export function sanitizeJson<T>(value: T): T
export function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value)
  if (Array.isArray(value)) return value.map(sanitizeJson)
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = sanitizeJson(item)
    return result
  }
  return value
}

// PostgreSQL cannot store NUL (U+0000) inside jsonb strings, and unpaired
// surrogates are not valid UTF-8. Tool output (for example `grep` on a binary
// file) can contain either, so sanitize values before they reach the database.
function sanitizeString(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}
