import path from "node:path"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { listAdapters } from "@/control-plane/adapters"
import { Workspace } from "@/control-plane/workspace"
import { Provisioner } from "@/control-plane/provisioner"
import { vmProjectsRoot } from "@/control-plane/vm-projects"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Authentication } from "@opencode-ai/core/authentication"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import * as InstanceState from "@/effect/instance-state"
import { Vcs } from "@/project/vcs"
import { getDevServerStatus } from "@/preview/server"
import { Cause, Effect } from "effect"
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

    const adapters = Effect.fn("WorkspaceHttpApi.adapters")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.sync(() => listAdapters(instance.project.id))
    })

    const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
      return yield* workspace.list((yield* InstanceState.context).project)
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
      const ids = new Set((yield* workspace.list((yield* InstanceState.context).project)).map((item) => item.id))
      return (yield* workspace.status()).filter((item) => ids.has(item.workspaceID))
    })

    const busy = Effect.fn("WorkspaceHttpApi.busy")(function* () {
      const instance = yield* InstanceState.context
      const execution = yield* SessionExecution.Service
      const appProcess = yield* AppProcess.Service
      const reasons: string[] = []
      const active = yield* execution.active
      if (active.size > 0) reasons.push(`sessions:${active.size}`)
      const running = yield* appProcess.running
      if (running > 0) reasons.push(`processes:${running}`)
      if (getDevServerStatus(instance.directory).running) reasons.push("preview")
      return { busy: reasons.length > 0, reasons }
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
      return (yield* provisioner.status(route.directory)) ?? null
    })

    const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (ctx: { params: { id: Workspace.Info["id"] } }) {
      return yield* workspace.remove(ctx.params.id)
    })

    const warp = Effect.fn("WorkspaceHttpApi.warp")(function* (ctx: { payload: typeof WarpPayload.Type }) {
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
