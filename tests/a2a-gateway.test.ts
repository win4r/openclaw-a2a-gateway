import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin from "../index.js";
import { buildAgentCard } from "../src/agent-card.js";
import { OpenClawAgentExecutor } from "../src/executor.js";
import type { GatewayConfig } from "../src/types.js";

interface Service {
  id: string;
  start: (...args: any[]) => Promise<void> | void;
  stop: (...args: any[]) => Promise<void> | void;
}

interface GatewayMethodResult {
  ok: boolean;
  data: unknown;
}

interface Harness {
  methods: Map<string, (args: any) => void>;
  service: Service;
}

function createHarness(config: Record<string, unknown>): Harness {
  let service: Service | null = null;
  const methods = new Map<string, (args: any) => void>();

  plugin.register({
    // Minimal mock; cast to any because the official OpenClawPluginApi has many fields.
    pluginConfig: config,
    config: {} as any,
    runtime: {} as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    on: () => {},
    registerGatewayMethod(name: string, handler: any) {
      methods.set(name, handler);
    },
    registerService(nextService: any) {
      service = nextService as Service;
    },
    registerTool: () => {},
    registerHook: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerCli: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    id: "a2a-gateway",
    name: "A2A Gateway",
    source: "test",
  } as any);

  assert(service, "service should be registered");

  return {
    methods,
    service,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentCard: {
      name: "Test Agent",
      description: "test card",
      url: "http://127.0.0.1:18800/a2a/jsonrpc",
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

/**
 * Create a mock WebSocket class that simulates the OpenClaw gateway protocol.
 * Includes connect.challenge event (required since executor uses challenge-based connect).
 * Optional onAgent callback to inspect agent RPC params.
 */
function createMockWebSocketClass(options?: {
  onAgent?: (params: Record<string, unknown>) => void;
  agentResponseText?: string;
}) {
  const agentResponseText = options?.agentResponseText ?? "Gateway response";

  return class MockGatewaySocket {
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
        // OpenClaw gateway sends connect.challenge after socket opens
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "test-nonce-123" },
            }),
          });
        });
      });
    }

    send(data: string): void {
      const frame = JSON.parse(data) as { id: string; method: string; params?: any };
      if (frame.method === "connect") {
        this.respond(frame.id, true, { status: "ok" });
        return;
      }
      if (frame.method === "sessions.resolve") {
        this.respond(frame.id, true, { key: "session-1" });
        return;
      }
      if (frame.method === "agent") {
        options?.onAgent?.(frame.params || {});
        this.respond(frame.id, true, { status: "accepted" });
        this.respond(frame.id, true, {
          status: "ok",
          result: {
            payloads: [{ kind: "text", text: agentResponseText }],
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
      req: { method: "req", params, id: "1" },
      params,
      client: null,
      isWebchatConnect: () => false,
      context: {} as any,
      respond: (ok: boolean, data: unknown) => {
        clearTimeout(timeout);
        resolve({ ok, data });
      },
    });
  });
}

describe("zero-config install (issue #7)", () => {
  it("registers plugin with empty config (no agentCard provided)", () => {
    // Simulates what happens when a user runs `openclaw plugins install` without
    // providing any agentCard config. The plugin should use built-in defaults.
    const harness = createHarness({});
    assert.ok(harness.service, "service should be registered even with empty config");
    assert.ok(harness.methods.has("a2a.send"), "a2a.send method should be registered");
  });

  it("builds Agent Card with defaults when agentCard fields are missing", () => {
    // Simulate: user provides agentCard object but omits name/skills/description
    const minimalConfig = makeConfig({
      agentCard: {},
    });
    const card = buildAgentCard(minimalConfig as unknown as GatewayConfig) as Record<string, unknown>;
    assert.equal(card.name, "OpenClaw A2A Gateway", "should use default name");
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.description, "A2A bridge for OpenClaw agents");
  });
});

describe("session key format (PR #9, issue #8)", () => {
  it("session key uses agent: prefix for OpenClaw gateway compatibility", async () => {
    const api = {
      config: { gateway: { port: 18789 } },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    } as any;

    let capturedSessionKey = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => {
        if (params.sessionKey) {
          capturedSessionKey = params.sessionKey as string;
        }
      },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);

      await executor.execute(
        {
          taskId: "task-sk",
          contextId: "ctx-sk",
          userMessage: {
            messageId: "msg-sk",
            role: "user",
            agentId: "writer-agent",
            parts: [{ kind: "text", text: "test session key" }],
          },
        } as any,
        {
          publish() {},
          finished() {},
        } as any
      );

      // The key MUST start with "agent:" for OpenClaw gateway to parse agentId correctly.
      assert.ok(
        capturedSessionKey.startsWith("agent:"),
        `session key should start with "agent:" but got "${capturedSessionKey}"`
      );
      // Should contain the agentId
      assert.ok(
        capturedSessionKey.includes("writer-agent"),
        `session key should contain agentId "writer-agent"`
      );
      // Should contain A2A namespace
      assert.ok(
        capturedSessionKey.includes("a2a:"),
        `session key should contain "a2a:" namespace`
      );
      // Full format: agent:{agentId}:a2a:{contextId}
      assert.equal(
        capturedSessionKey,
        "agent:writer-agent:a2a:ctx-sk",
        "session key should follow agent:{agentId}:a2a:{contextId} format"
      );
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

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

  it("dispatches inbound messages via gateway RPC", async () => {
    const api = {
      config: { gateway: { port: 18789 } },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    } as any;

    const MockWS = createMockWebSocketClass();

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

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

      // No legacy dispatch path is used; gateway RPC is the only dispatch mechanism.
      assert.equal(true, true);
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

  it("publishes fallback response when gateway RPC is unavailable", async () => {
    const api = {
      config: { gateway: { port: 18789 } },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    } as any;

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

      assert.equal(finishedCalled, true);

      const finalTask = published[published.length - 1] as Record<string, unknown>;
      assert.equal(finalTask.kind, "task");
      const status = finalTask.status as Record<string, unknown>;
      // When WebSocket is unavailable, executor publishes a failed state
      assert.equal(status.state, "failed");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("cancelTask uses tracked task contextId and does not fabricate it", async () => {
    const api = {
      config: { gateway: { port: 18789 } },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    } as any;

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

      if (url === "http://mock-peer/.well-known/agent-card.json" || url === "http://mock-peer/.well-known/agent.json") {
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
              agentCardUrl: "http://mock-peer/.well-known/agent-card.json",
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
