/** Preserve libpq URI options while keeping the login password out of process arguments. */
export function psqlConnection(input: { readonly url: string; readonly schema: string }) {
  const url = new URL(input.url)
  const password = url.searchParams.getAll("password").at(-1) ?? decodeURIComponent(url.password)
  url.password = ""
  url.searchParams.delete("password")
  // libpq URI parsing expects percent-encoded spaces, not URLSearchParams' form-style '+'.
  url.search = url.searchParams.toString().replaceAll("+", "%20")
  return {
    args: [url.toString()],
    env: { PGPASSWORD: password, PGOPTIONS: `-c search_path=${input.schema},pg_catalog` },
  }
}
