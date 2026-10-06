import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { McpAuth } from "../../src/mcp/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live("serializes concurrent auth updates across independent database connections", () =>
  Effect.gen(function* () {
    // Keep both pools alive until assertions finish; no in-memory or filesystem auth substitute.
    const firstContext = yield* Layer.build(Layer.fresh(LayerNode.compile(McpAuth.node)))
    const secondContext = yield* Layer.build(Layer.fresh(LayerNode.compile(McpAuth.node)))
    const first = Context.get(firstContext, McpAuth.Service)
    const second = Context.get(secondContext, McpAuth.Service)

    yield* Effect.all(
      [
        first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
        second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
      ],
      { concurrency: "unbounded" },
    )

    const entry = yield* first.get("posthog")
    expect(entry?.tokens?.accessToken).toBe("access-token")
    expect(entry?.clientInfo?.clientId).toBe("client-id")
    expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
    expect(yield* second.get("posthog")).toEqual(entry)
  }),
)
