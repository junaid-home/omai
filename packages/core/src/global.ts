import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"
import { CentralStorage } from "./storage/central"

const app = "omai"
const legacyApp = "opencode"

// Prefer the legacy `opencode` directory when it already holds state, so upgrades
// keep reading existing config/data/auth instead of starting from an empty tree.
function resolve(base: string) {
  const legacy = path.join(base, legacyApp)
  const current = path.join(base, app)
  return !fsSync.existsSync(current) && fsSync.existsSync(legacy) ? legacy : current
}

const central = CentralStorage.current()
// Verify a pre-provisioned mount before creating any directory. Never recreate
// a missing central volume on the container's disposable root filesystem.
await CentralStorage.check()
const data = central ? path.join(central.root, "data") : resolve(xdgData!)
const cache = central ? path.join(central.root, "cache") : resolve(xdgCache!)
const config = central ? path.join(central.root, "config") : resolve(xdgConfig!)
const state = central ? path.join(central.root, "state") : resolve(xdgState!)
// Temp state is disposable, so it never falls back: always /tmp/omai.
const tmp = path.join(os.tmpdir(), app, ...(central ? [central.id] : []))

const paths = {
  get home() {
    return central ? path.join(central.root, "home") : (process.env.OPENCODE_TEST_HOME ?? os.homedir())
  },
  // True while an existing install still resolves its data dir to the legacy
  // `opencode` name. Artifacts that must keep matching existing files (the
  // database) branch on this until the legacy tree is migrated.
  legacy: !central && data.endsWith(legacyApp),
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  workspaces: central ? path.join(central.root, "workspaces") : undefined,
  worktrees: central ? path.join(central.root, "workspaces", "worktrees") : path.join(data, "worktree"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

if (central) {
  for (const target of [Path.data, Path.config, Path.state, Path.log, Path.bin, Path.repos, Path.home, Path.worktrees])
    await CentralStorage.resolveManaged(target)
}

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: central ? Path.config : (Flag.OPENCODE_CONFIG_DIR ?? Path.config),
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
