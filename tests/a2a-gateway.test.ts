import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin from "../index.js";
import { buildAgentCard } from "../src/agent-card.js";
import { OpenClawAgentExecutor } from "../src/executor.js";
import type { GatewayConfig, OpenClawPluginApi } from "../src/types.js";

interface Service {
  id: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  __app?: unknown;
}

interface GatewayMethodResult {
  ok: boolean;
  data: unknown;
}

interface Harness {
  methods: Map<string, (args: { params?: Record<string, unknown>; respond: (ok: boolean, data: unknown) => void }) => void>;
  service: Service;
  dispatchCalls: Array<{ agentId: string; event: unknown }>;
}

function createHarness(config: Record<string, unknown>): Harness {
  let service: Service | null = null;
  const methods = new Map<string, (args: { params?: Record<string, unknown>; respond: (ok: boolean, data: unknown) => void }) => void>();
  const dispatchCalls: Array<{ agentId: string; event: unknown }> = [];

  plugin.register({
    pluginConfig: config,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    on: () => {},
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerService(nextService) {
      service = nextService as Service;
    },
    async dispatchToAgent(agentId, event) {
      dispatchCalls.push({ agentId, event });
      return { accepted: true, response: "Request processed" };
    },
  });

  assert(service, "service should be registered");

  return {
    methods,
    service,
    dispatchCalls,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentCard: {
      name: "Test Agent",
      description: "test card",
      url: "http://127.0.0.1:18800/.well-known/agent.json",
      skills: [{ name: "chat" }],
    },
    server: {
      host: "127.0.0.1",
      port: 18800,
    },
    peers: [],
    security: {
      inboundAuth: "none",
    },
    routing: {
      defaultAgentId: "default-agent",
    },
    ...overrides,
  };
}

async function invokeGatewayMethod(
  harness: Harness,
  methodName: string,
  params: Record<string, unknown>
): Promise<GatewayMethodResult> {
  const method = harness.methods.get(methodName);
  assert(method, `missing gateway method ${methodName}`);

  return await new Promise<GatewayMethodResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${methodName}`)), 3000);

    method({
      params,
      respond: (ok, data) => {
        clearTimeout(timeout);
        resolve({ ok, data });
      },
    });
  });
}

describe("a2a-gateway plugin", () => {
  it("builds an Agent Card with protocolVersion 0.3.0 and required fields", async () => {
    const payload = buildAgentCard(makeConfig() as unknown as GatewayConfig) as Record<string, unknown>;
    assert.equal(payload.protocolVersion, "0.3.0");
    assert.equal(payload.name, "Test Agent");

    // Verify spec-required fields
    assert.ok(payload.securitySchemes !== undefined, "securitySchemes should be present");
    assert.ok(payload.security !== undefined, "security should be present");

    const capabilities = payload.capabilities as Record<string, unknown>;
    assert.equal(capabilities.streaming, false);
    assert.equal(capabilities.pushNotifications, false);
    assert.equal(capabilities.stateTransitionHistory, false);
  });

  it("prefers gateway RPC dispatch over legacy bridge", async () => {
    const dispatchCalls: Array<{ agentId: string; event: unknown }> = [];
    const api: OpenClawPluginApi = {
      config: { gateway: { port: 18789 } },
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      on: () => {},
      registerGatewayMethod: () => {},
      registerService: () => {},
      async dispatchToAgent(agentId, event) {
        dispatchCalls.push({ agentId, event });
        return { accepted: true, response: "Legacy response" };
      },
    };

    class MockGatewaySocket {
      readyState = 0;
      private readonly listeners = new Map<string, Set<(event: any) => void>>();

      constructor(_url: string) {
        this.listeners.set("open", new Set());
        this.listeners.set("message", new Set());
        this.listeners.set("error", new Set());
        this.listeners.set("close", new Set());
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open", {});
        });
      }

      send(data: string): void {
        const frame = JSON.parse(data) as { id: string; method: string };
        if (frame.method === "connect") {
          this.respond(frame.id, true, { status: "ok" });
          return;
        }
        if (frame.method === "sessions.resolve") {
          this.respond(frame.id, true, { key: "session-1" });
          return;
        }
        if (frame.method === "agent") {
          this.respond(frame.id, true, { status: "accepted" });
          this.respond(frame.id, true, {
            status: "ok",
            result: {
              payloads: [{ kind: "text", text: "Gateway response" }],
            },
          });
          return;
        }
        this.respond(frame.id, false, null, { message: `unsupported method ${frame.method}` });
      }

      close(): void {
        this.readyState = 3;
        this.emit("close", {});
      }

      addEventListener(type: string, listener: (event: any) => void): void {
        if (!this.listeners.has(type)) {
          this.listeners.set(type, new Set());
        }
        this.listeners.get(type)?.add(listener);
      }

      removeEventListener(type: string, listener: (event: any) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      private respond(id: string, ok: boolean, payload?: unknown, error?: unknown): void {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "res",
              id,
              ok,
              payload,
              error,
            }),
          });
        });
      }

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) || []) {
          listener(event);
        }
      }
    }

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockGatewaySocket;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];
      let finishedCalled = false;

      await executor.execute(
        {
          taskId: "task-1",
          contextId: "ctx-1",
          userMessage: {
            messageId: "msg-1",
            role: "user",
            agentId: "writer-agent",
            parts: [{ kind: "text", text: "hello" }],
          },
        } as any,
        {
          publish(event: unknown) {
            published.push(event);
          },
          finished() {
            finishedCalled = true;
          },
        } as any
      );

      assert.equal(dispatchCalls.length, 0);
      assert.equal(finishedCalled, true);

      const finalTask = published[published.length - 1] as Record<string, unknown>;
      const status = finalTask.status as Record<string, unknown>;
      const message = status.message as Record<string, unknown>;
      const parts = message.parts as Array<Record<string, unknown>>;
      assert.equal(parts[0].text, "Gateway response");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("falls back to legacy bridge and publishes completed task when gateway path is unavailable", async () => {
    const dispatchCalls: Array<{ agentId: string; event: unknown }> = [];
    const api: OpenClawPluginApi = {
      config: { gateway: { port: 18789 } },
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      on: () => {},
      registerGatewayMethod: () => {},
      registerService: () => {},
      async dispatchToAgent(agentId, event) {
        dispatchCalls.push({ agentId, event });
        return { accepted: true, response: "Request processed" };
      },
    };

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = undefined;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];
      let finishedCalled = false;

      await executor.execute(
        {
          taskId: "task-1",
          contextId: "ctx-1",
          userMessage: {
            messageId: "msg-1",
            role: "user",
            agentId: "writer-agent",
            parts: [{ kind: "text", text: "hello" }],
          },
        } as any,
        {
          publish(event: unknown) {
            published.push(event);
          },
          finished() {
            finishedCalled = true;
          },
        } as any
      );

      assert.equal(dispatchCalls.length, 1);
      assert.equal(dispatchCalls[0].agentId, "writer-agent");
      assert.equal(finishedCalled, true);

      const finalTask = published[published.length - 1] as Record<string, unknown>;
      assert.equal(finalTask.kind, "task");
      const status = finalTask.status as Record<string, unknown>;
      assert.equal(status.state, "completed");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("cancelTask uses tracked task contextId and does not fabricate it", async () => {
    const api: OpenClawPluginApi = {
      config: { gateway: { port: 18789 } },
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      on: () => {},
      registerGatewayMethod: () => {},
      registerService: () => {},
      async dispatchToAgent() {
        return { accepted: true, response: "Request processed" };
      },
    };

    const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
    (executor as any).taskContextByTaskId.set("task-1", "ctx-1");

    const published: Array<Record<string, unknown>> = [];
    let finishedCalled = false;

    await executor.cancelTask("task-1", {
      publish(event: unknown) {
        published.push(event as Record<string, unknown>);
      },
      finished() {
        finishedCalled = true;
      },
    } as any);

    assert.equal(finishedCalled, true);
    assert.equal(published.length, 1);
    assert.equal(published[0].id, "task-1");
    assert.equal(published[0].contextId, "ctx-1");
  });

  it("a2a.send sends to mocked peer JSON-RPC endpoint", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "http://mock-peer/.well-known/agent.json") {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Peer Agent",
            // Per A2A spec, the Agent Card `url` field is the service endpoint.
            url: "http://mock-peer/a2a/jsonrpc",
            skills: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      if (url === "http://mock-peer/a2a/jsonrpc") {
        const bodyText = String(init?.body || "{}");
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        received.push(payload);

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              accepted: true,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [
            {
              name: "peer-1",
              agentCardUrl: "http://mock-peer/.well-known/agent.json",
            },
          ],
        })
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "peer-1",
        message: {
          agentId: "peer-agent",
          text: "ping",
        },
      });

      assert.equal(result.ok, true);
      assert.equal(received.length, 1);
      assert.equal(received[0].method, "message/send");

      const params = received[0].params as Record<string, unknown>;
      assert.equal(typeof params, "object");

      const msg = (params as any)?.message as Record<string, unknown>;
      assert.equal(typeof msg, "object");
      // OpenClaw extension: agentId should be forwarded for peer-side routing.
      assert.equal(msg.agentId, "peer-agent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
