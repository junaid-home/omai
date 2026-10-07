import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Duration, Effect, Layer, Scope } from "effect"
import { TestLLMServer } from "../../lib/llm-server"
import type { Config } from "../../../src/config/config"

import type { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID } from "../../../src/session/schema"
import { call, callAuthProbe, disposeApps, request } from "./backend"
import { check, object } from "./assertions"
import { original } from "./environment"
import { runtime } from "./runtime"
import type { ActiveScenario, Options, ProjectOptions, Result, Scenario, ScenarioContext, SeededContext } from "./types"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export function runScenario(options: Options) {
  return (scenario: Scenario) => {
    if (scenario.kind === "todo") return Effect.succeed({ status: "skip", scenario } as Result)
    return withAuthentication(scenario, runActive(options, scenario)).pipe(
      Effect.timeoutOrElse({
        duration: options.scenarioTimeout,
        orElse: () => Effect.die(new Error(`scenario timed out after ${Duration.format(options.scenarioTimeout)}`)),
      }),
      Effect.as({ status: "pass", scenario } as Result),
      Effect.catchCause((cause) => Effect.succeed({ status: "fail" as const, scenario, message: Cause.pretty(cause) })),
      Effect.scoped,
    )
  }
}

function runActive(options: Options, scenario: ActiveScenario) {
  if (options.mode === "auth" && !scenario.central) return runAuth(scenario)

  return withContext(options, scenario, "shared", (ctx) =>
    Effect.gen(function* () {
      if (options.mode === "auth" && scenario.central) {
        const spec = scenario.request(ctx, ctx.state)
        const headers = { ...spec.headers }
        delete headers.cookie
        delete headers.authorization
        const anonymous = yield* request(scenario.method, { ...spec, headers })
        if (scenario.auth === "protected") {
          check(anonymous.status === 401, `central anonymous access should be denied, got ${anonymous.status}`)
        } else {
          yield* scenario.expect(ctx, ctx.state, anonymous)
          return
        }
      }
      yield* trace(options, scenario, "request start")
      const result = yield* call(scenario, ctx)
      yield* trace(options, scenario, `response ${result.status}`)
      yield* trace(options, scenario, "expect start")
      yield* scenario.expect(ctx, ctx.state, result)
      yield* trace(options, scenario, "expect done")
    }),
  )
}

function withAuthentication<A, E, R>(scenario: ActiveScenario, effect: Effect.Effect<A, E, R>) {
  if (!scenario.central) return effect
  const environment = {
    OPENCODE_AUTH_MODE: "central",
    OPENCODE_PUBLIC_URL: "https://app.example.test",
    OPENCODE_PREVIEW_URL: "https://preview.example.test",
    OPENCODE_JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    OPENCODE_REGISTRATION_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  }
  // The process .env may carry real Google credentials; central scenarios assert
  // the unconfigured behavior, so the exercise backend must never see them.
  const googleKeys = ["OPENCODE_GOOGLE_CLIENT_ID", "OPENCODE_GOOGLE_CLIENT_SECRET"]
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      await disposeApps()
      const previous = new Map([...Object.keys(environment), ...googleKeys].map((key) => [key, process.env[key]]))
      Object.assign(process.env, environment)
      for (const key of googleKeys) delete process.env[key]
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.promise(async () => {
        await disposeApps()
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

function runAuth(scenario: ActiveScenario) {
  // Valid auth probes can execute mutating handlers, even with an empty payload.
  // Give every probe pair its own workspace instead of falling back to process.cwd().
  return Effect.acquireUseRelease(
    Effect.promise(async () => (await runtime()).tmpdir()),
    (directory) =>
      Effect.gen(function* () {
        const result = yield* callAuthProbe(scenario, directory.path, "missing")
        if (scenario.auth === "protected") {
          if (result.status !== 401) throw new Error(`auth expected 401, got ${result.status}`)
          const authed = yield* callAuthProbe(scenario, directory.path, "valid")
          if (authed.status === 401) throw new Error("auth rejected valid credentials")
          return
        }

        if (result.status === 401) throw new Error("auth expected public access, got 401")
        if (result.timedOut) throw new Error("auth expected public access, probe timed out")
      }),
    (directory) =>
      Effect.promise(async () => {
        await directory[Symbol.asyncDispose]()
      }),
  )
}

function withContext<A, E>(
  options: Options,
  scenario: ActiveScenario,
  label: string,
  use: (ctx: SeededContext<unknown>) => Effect.Effect<A, E, Scope.Scope>,
) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* trace(options, scenario, `${label} context acquire start`)
      const llm = scenario.project?.llm ? yield* TestLLMServer : undefined
      const project = scenario.project
      const dir = project
        ? yield* Effect.promise(async () => (await runtime()).tmpdir(projectOptions(project, llm?.url)))
        : undefined
      yield* trace(options, scenario, `${label} context acquire done`)
      return { dir, llm }
    }),
    (ctx) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} tmpdir cleanup start`)
        yield* Effect.promise(async () => {
          await ctx.dir?.[Symbol.asyncDispose]()
        }).pipe(Effect.ignore)
        yield* trace(options, scenario, `${label} tmpdir cleanup done`)
      }),
  ).pipe(
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} runtime start`)
        const modules = yield* Effect.promise(() => runtime())
        const scope = yield* Scope.Scope
        const app = yield* Layer.buildWithMemoMap(modules.AppLayer, modules.memoMap, scope)
        yield* trace(options, scenario, `${label} runtime done`)
        const path = context.dir?.path
        const instance = path
          ? yield* trace(options, scenario, `${label} instance load start`).pipe(
              Effect.andThen(
                modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                  Effect.provide(app),
                  Effect.catchCause((cause) =>
                    Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                          Effect.provide(app),
                        ),
                      ),
                      Effect.catchCause(() => Effect.failCause(cause)),
                    ),
                  ),
                ),
              ),
              Effect.tap(() => trace(options, scenario, `${label} instance load done`)),
            )
          : undefined
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(modules.InstanceRef, instance), Effect.provide(app))
        const directory = () => {
          if (!context.dir?.path) throw new Error("scenario needs a project directory")
          return context.dir.path
        }
        const llm = () => {
          if (!context.llm) throw new Error("scenario needs fake LLM")
          return context.llm
        }
        const account = scenario.central ? yield* provisionAccount() : undefined
        const headers = (extra?: Record<string, string>): Record<string, string> => ({
          ...(context.dir?.path ? { "x-opencode-directory": context.dir.path } : {}),
          ...(account
            ? { cookie: account.cookie, origin: "https://app.example.test", "x-opencode-user-id": account.id }
            : {}),
          ...extra,
        })
        const base: ScenarioContext = {
          checkpoint: () =>
            Effect.gen(function* () {
              const session = yield* base.session({ title: "checkpoint fixture" })
              const message = yield* base.message(session.id)
              const from = yield* run(modules.Snapshot.Service.use((value) => value.track()))
              check(!!from, "checkpoint fixture must capture its initial snapshot")
              yield* base.file("checkpoint.txt", "captured content\n")
              const hash = yield* run(modules.Snapshot.Service.use((value) => value.track()))
              check(!!hash, "checkpoint fixture must capture its modified snapshot")
              const checkpoint = yield* run(
                modules.Checkpoint.Service.use((value) =>
                  value
                    .create({
                      from,
                      hash,
                      sessionID: session.id,
                      messageID: message.info.id,
                      title: "HTTP checkpoint",
                    })
                    .pipe(Effect.orDie),
                ),
              )
              check(!!checkpoint, "fixture must persist a checkpoint")
              return checkpoint
            }),
          account,
          request: (method, spec) => request(method, { ...spec, headers: headers(spec.headers) }),
          providerAuthGet: (providerID) =>
            run(modules.Auth.Service.use((auth) => auth.get(providerID).pipe(Effect.orDie))),
          providerAuthSet: (providerID, info) =>
            run(modules.Auth.Service.use((auth) => auth.set(providerID, info).pipe(Effect.orDie))),
          directory: context.dir?.path,
          headers,
          file: (name, content) =>
            Effect.promise(() => {
              return Bun.write(`${directory()}/${name}`, content)
            }).pipe(Effect.asVoid),
          session: (input) =>
            run(modules.Session.Service.use((svc) => svc.create({ title: input?.title, parentID: input?.parentID }))),
          sessionGet: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.get(sessionID))).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
          project: () =>
            Effect.sync(() => {
              if (!instance) throw new Error("scenario needs a project directory")
              return instance.project
            }),
          message: (sessionID, input) =>
            Effect.gen(function* () {
              const info: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "build",
                model: {
                  providerID: ProviderV2.ID.opencode,
                  modelID: ModelV2.ID.make("test"),
                },
              }
              const part: SessionV1.TextPart = {
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text: input?.text ?? "hello",
              }
              yield* run(
                modules.Session.Service.use((svc) =>
                  Effect.gen(function* () {
                    yield* svc.updateMessage(info)
                    yield* svc.updatePart(part)
                  }),
                ),
              )
              return { info, part }
            }),
          messages: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.messages({ sessionID }).pipe(Effect.orDie))),
          todos: (sessionID, todos) => run(modules.Todo.Service.use((svc) => svc.update({ sessionID, todos }))),
          worktree: (input) => run(modules.Worktree.Service.use((svc) => svc.create(input).pipe(Effect.orDie))),
          worktreeRemove: (directory) =>
            run(modules.Worktree.Service.use((svc) => svc.remove({ directory })).pipe(Effect.ignore)),
          llmText: (value) => Effect.suspend(() => llm().text(value)),
          llmWait: (count) => Effect.suspend(() => llm().wait(count)),
          tuiRequest: (request) => Effect.sync(() => modules.Tui.submitTuiRequest(request)),
        }
        yield* trace(options, scenario, `${label} seed start`)
        const state = yield* scenario.seed(base)
        yield* trace(options, scenario, `${label} seed done`)
        yield* trace(options, scenario, `${label} use start`)
        const result = yield* use({ ...base, state })
        yield* trace(options, scenario, `${label} use done`)
        return result
      }).pipe(Effect.ensuring(context.llm ? context.llm.reset : Effect.void)),
    ),
    Effect.ensuring(scenario.reset ? resetState : Effect.void),
  )
}

function provisionAccount() {
  return Effect.gen(function* () {
    const username = `httpapi_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
    const email = `${username}@example.test`
    const password = `Test only ${crypto.randomUUID()}`
    const response = yield* request("POST", {
      path: "/auth/signup",
      headers: { origin: "https://app.example.test" },
      body: { username, email, password, inviteToken: process.env.OPENCODE_REGISTRATION_SECRET },
    })
    check(response.status === 200, `fixture signup failed with ${response.status}: ${response.text}`)
    object(response.body)
    object(response.body.user)
    check(typeof response.body.user.id === "string", "signup should issue a user identity")
    const cookie = response.headers.get("set-cookie")?.split(";")[0]
    check(!!cookie, "signup should issue a session cookie")
    return { id: response.body.user.id, username, email, password, cookie }
  })
}

function trace(options: Options, scenario: ActiveScenario, phase: string) {
  return Effect.sync(() => {
    if (!options.trace) return
    console.log(`[trace] ${scenario.name}: ${phase}`)
  })
}

function projectOptions(
  project: ProjectOptions,
  llmUrl: string | undefined,
): { git?: boolean; config?: Partial<ConfigV1.Info> } {
  if (!project.llm || !llmUrl) return { git: project.git, config: project.config }
  const fake = fakeLlmConfig(llmUrl)
  return {
    git: project.git,
    config: {
      ...fake,
      ...project.config,
      provider: {
        ...fake.provider,
        ...project.config?.provider,
      },
    },
  }
}

function fakeLlmConfig(url: string): Partial<ConfigV1.Info> {
  return {
    model: "test/test-model",
    small_model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const resetState = Effect.promise(async () => {
  const modules = await runtime()
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  await disposeApps()
  await modules.disposeAllInstances()
  await modules.resetDatabase()
  await Bun.sleep(25)
})
