import path from "node:path"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { listAdapters } from "@/control-plane/adapters"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceBusy } from "@/control-plane/workspace-busy"
import { WorkspaceOwner } from "@/control-plane/workspace-owner"
import { Session } from "@/session/session"
import { Provisioner } from "@/control-plane/provisioner"
import { vmProjectsRoot } from "@/control-plane/vm-projects"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Authentication } from "@opencode-ai/core/authentication"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import * as InstanceState from "@/effect/instance-state"
import { Vcs } from "@/project/vcs"
import { getDevServerStatus } from "@/preview/server"
import { Cause, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { ApiVcsApplyError } from "../groups/instance"
import {
  ApiWorkspaceCreateError,
  ApiWorkspaceWarpError,
  CreatePayload,
  ProvisionPayload,
  WarpPayload,
} from "../groups/workspace"

export const workspaceHandlers = HttpApiBuilder.group(InstanceHttpApi, "workspace", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service

    // Every user's VMs hang off the control plane's one project: a signed-in
    // user sees and acts on only their own.
    const permitted = Effect.fn("WorkspaceHttpApi.permitted")(function* (info: { readonly extra?: unknown }) {
      const principal = yield* Authentication.Current
      return WorkspaceOwner.permits(principal?.userID, info)
    })
    const ownList = Effect.fn("WorkspaceHttpApi.ownList")(function* () {
      return yield* Effect.filter(yield* workspace.list((yield* InstanceState.context).project), permitted)
    })

    const adapters = Effect.fn("WorkspaceHttpApi.adapters")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.sync(() => listAdapters(instance.project.id))
    })

    const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
      return yield* ownList()
    })

    const create = Effect.fn("WorkspaceHttpApi.create")(function* (ctx: { payload: typeof CreatePayload.Type }) {
      const instance = yield* InstanceState.context
      return yield* workspace
        .create({
          ...ctx.payload,
          extra: ctx.payload.extra ?? null,
          projectID: instance.project.id,
        })
        .pipe(
          Effect.catchCause((cause) => {
            // Plugin throws surface as defects (because EffectBridge.fromPromise uses Effect.promise),
            // bypassing Effect.mapError. Walk the cause to surface the real error to the client.
            const die = cause.reasons.find(Cause.isDieReason)
            const fail = cause.reasons.find(Cause.isFailReason)
            const reason: unknown = die?.defect ?? fail?.error
            const message = reason instanceof Error ? reason.message : "Workspace creation failed"
            return Effect.fail(
              new ApiWorkspaceCreateError({
                name: "WorkspaceCreateError",
                data: { message },
              }),
            )
          }),
        )
    })

    const syncList = Effect.fn("WorkspaceHttpApi.syncList")(function* () {
      yield* workspace.syncList((yield* InstanceState.context).project)
    })

    const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
      const ids = new Set((yield* ownList()).map((item) => item.id))
      return (yield* workspace.status()).filter((item) => ids.has(item.workspaceID))
    })

    const busy = Effect.fn("WorkspaceHttpApi.busy")(function* () {
      const instance = yield* InstanceState.context
      const execution = yield* SessionExecution.Service
      const appProcess = yield* AppProcess.Service
      const report = yield* WorkspaceBusy.report({
        execution,
        appProcess,
        preview: getDevServerStatus(instance.directory).running,
      })
      return { busy: report.busy, reasons: [...report.reasons] }
    })

    const provision = Effect.fn("WorkspaceHttpApi.provision")(function* (ctx: {
      payload: typeof ProvisionPayload.Type
    }) {
      const route = yield* WorkspaceRouteContext
      const provisioner = yield* Provisioner.Service
      const rejected = (message: string) =>
        Effect.fail(new ApiWorkspaceCreateError({ name: "WorkspaceCreateError", data: { message } }))
      if (!Flag.OPENCODE_WORKSPACE_ADAPTER) return yield* rejected("No workspace adapter is configured")
      // Only project folders under the VM projects root get a VM of their own;
      // resolve first so `..` segments cannot step outside it.
      const root = vmProjectsRoot()
      const directory = path.resolve(route.directory)
      const relative = root ? path.relative(path.resolve(root), directory) : directory
      if (root && (!relative || relative.startsWith("..") || path.isAbsolute(relative)))
        return yield* rejected(`Project directory must be under ${root}`)
      // Another user's project folder is theirs, even when its setup failed
      // and would otherwise be retried as a fresh VM.
      const existing = yield* workspace.getByDirectory(directory)
      if (existing && !(yield* permitted(existing))) return yield* rejected("Project directory is already in use")
      const principal = yield* Authentication.Current
      return yield* provisioner.start({
        directory,
        mode: ctx.payload.mode,
        owner: principal && { userID: principal.userID, username: principal.username, email: principal.email },
      })
    })

    const provisionStatus = Effect.fn("WorkspaceHttpApi.provisionStatus")(function* () {
      const route = yield* WorkspaceRouteContext
      const provisioner = yield* Provisioner.Service
      const existing = yield* workspace.getByDirectory(route.directory)
      if (existing && !(yield* permitted(existing))) return null
      return (yield* provisioner.status(route.directory)) ?? null
    })

    const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (ctx: { params: { id: Workspace.Info["id"] } }) {
      const found = yield* workspace.get(ctx.params.id)
      if (!found || !(yield* permitted(found))) return undefined
      return yield* workspace.remove(ctx.params.id)
    })

    const warp = Effect.fn("WorkspaceHttpApi.warp")(function* (ctx: { payload: typeof WarpPayload.Type }) {
      // Both ends of the move must be the caller's: the workspace the session
      // leaves and the one it lands in.
      const sessions = yield* Session.Service
      const session = yield* sessions.get(ctx.payload.sessionID).pipe(Effect.option)
      const ends = [ctx.payload.id, Option.getOrUndefined(session)?.workspaceID].filter((id) => id != null)
      const owned = yield* Effect.forEach(ends, (id) =>
        workspace.get(id).pipe(Effect.flatMap((info) => (info ? permitted(info) : Effect.succeed(false)))),
      )
      if (owned.includes(false)) return yield* notFound(`Workspace not found: ${ctx.payload.id}`)
      yield* workspace
        .sessionWarp({
          workspaceID: ctx.payload.id,
          sessionID: ctx.payload.sessionID,
          copyChanges: ctx.payload.copyChanges,
        })
        .pipe(
          Effect.mapError((error) => {
            if (error instanceof Workspace.WorkspaceNotFoundError) return notFound(error.message)
            if (error instanceof Vcs.PatchApplyError) {
              return new ApiVcsApplyError({
                name: "VcsApplyError",
                data: {
                  message: error.message,
                  reason: error.reason,
                },
              })
            }
            return new ApiWorkspaceWarpError({
              name: "WorkspaceWarpError",
              data: {
                message: error.message,
              },
            })
          }),
        )
    })

    return handlers
      .handle("adapters", adapters)
      .handle("list", list)
      .handle("create", create)
      .handle("syncList", syncList)
      .handle("status", status)
      .handle("busy", busy)
      .handle("provision", provision)
      .handle("provisionStatus", provisionStatus)
      .handle("remove", remove)
      .handle("warp", warp)
  }),
)
