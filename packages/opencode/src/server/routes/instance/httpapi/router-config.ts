// find-my-way drops path params longer than 100 chars (its default maxParamLength),
// so base64url-encoded absolute paths such as /preview/thumbnail/:encodedDir stop
// matching their route and fall through to a 404 for long directories.
export const routerConfig = { maxParamLength: 8192 }

export * as RouterConfig from "./router-config"
