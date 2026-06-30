/**
 * Shared test helpers — extracted from duplicate code across test files.
 *
 * Provides: mock factories, config builders, plugin registration helpers.
 */
import assert from "node:assert/strict";

import { TaskState } from "@a2a-js/sdk";

import plugin from "../index.js";
import type { GatewayConfig } from "../src/types.js";
import { primaryAgentUrl, primaryProtocolVersion } from "../src/agent-card.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Service {
  id: string;
  start: (...args: any[]) => Promise<void> | void;
  stop: (...args: any[]) => Promise<void> | void;
}

export interface GatewayMethodResult {
  ok: boolean;
  data: unknown;
}

export interface Harness {
  methods: Map<string, (args: any) => void>;
  service: Service;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

export function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      allowedMimeTypes: ["image/*", "application/pdf", "text/plain", "text/csv", "application/json", "audio/*", "video/*"],
      maxFileSizeBytes: 52_428_800,
      maxInlineFileSizeBytes: 10_485_760,
      fileUriAllowlist: [],
    },
    routing: {
      defaultAgentId: "default-agent",
    },
    ...overrides,
  };
}

export function createApi() {
  return {
    config: { gateway: { port: 18789 } },
    logger: silentLogger(),
  } as any;
}

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

export function createMockWebSocketClass(options?: {
  onAgent?: (params: Record<string, unknown>) => void;
  onConnect?: (params: Record<string, unknown>) => Record<string, unknown>;
  agentResponseText?: string;
  agentResponsePayloads?: Array<Record<string, unknown>>;
}) {
  const agentResponseText = options?.agentResponseText ?? "Gateway response";
  const agentResponsePayloads = options?.agentResponsePayloads;

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
        if (options?.onConnect) {
          try {
            const result = options.onConnect(frame.params || {});
            this.respond(frame.id, true, result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.respond(frame.id, false, null, { message: msg });
          }
        } else {
          this.respond(frame.id, true, { status: "ok" });
        }
        return;
      }
      if (frame.method === "sessions.resolve") {
        this.respond(frame.id, true, { key: "session-1" });
        return;
      }
      if (frame.method === "agent") {
        options?.onAgent?.(frame.params || {});
        this.respond(frame.id, true, { status: "accepted" });
        const payloads = agentResponsePayloads ?? [{ text: agentResponseText }];
        this.respond(frame.id, true, {
          status: "ok",
          result: { payloads },
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

// ---------------------------------------------------------------------------
// Event bus (simple version for tests that use `as any`)
// ---------------------------------------------------------------------------

export function createEventBus() {
  const events: unknown[] = [];
  let finishedCalled = false;

  return {
    events,
    isFinished: () => finishedCalled,
    bus: {
      publish(event: unknown) {
        events.push(event);
      },
      finished() {
        finishedCalled = true;
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export function registerPlugin(config: Record<string, unknown>) {
  let service: Service | null = null;
  const methods = new Map<string, (args: any) => void>();
  const tools = new Map<string, any>();

  plugin.register({
    pluginConfig: config,
    config: { gateway: { port: 18789 } } as any,
    runtime: {} as any,
    logger: silentLogger(),
    on: () => {},
    registerGatewayMethod(name: string, handler: any) {
      methods.set(name, handler);
    },
    registerService(svc: any) {
      service = svc;
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
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

  return { service, methods, tools };
}

// ---------------------------------------------------------------------------
// Harness (plugin registration with assertions)
// ---------------------------------------------------------------------------

export function createHarness(config: Record<string, unknown>): Harness {
  const { service, methods } = registerPlugin(config);
  assert(service, "service should be registered");
  return { methods, service };
}

export async function invokeGatewayMethod(
  harness: Harness,
  methodName: string,
  params: Record<string, unknown>,
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

// ---------------------------------------------------------------------------
// A2A v1 test helpers
// ---------------------------------------------------------------------------

export function v1TextPart(text: string) {
  return { text };
}

export function v1UserMessage(text: string, extras: Record<string, unknown> = {}) {
  return {
    messageId: "msg-1",
    role: "ROLE_USER",
    parts: [v1TextPart(text)],
    ...extras,
  };
}

export function unwrapPublishedTask(event: unknown): Record<string, unknown> {
  const obj = event as { kind?: string; data?: Record<string, unknown> };
  if (obj.kind === "task" && obj.data) {
    return obj.data;
  }
  return obj as Record<string, unknown>;
}

export function lastPublishedTask(published: unknown[]): Record<string, unknown> {
  return unwrapPublishedTask(published[published.length - 1]);
}

export function executionTaskState(event: unknown): TaskState | undefined {
  return (unwrapPublishedTask(event).status as { state?: TaskState } | undefined)?.state;
}

export function partTextFromJson(part: Record<string, unknown>): string {
  const content = part.content as { $case?: string; value?: string } | undefined;
  if (content?.$case === "text" && typeof content.value === "string") {
    return content.value;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  return "";
}

export function assertPrimaryProtocolVersion(card: Record<string, unknown>, expected = "1.0") {
  assert.equal(primaryProtocolVersion(card as any), expected);
}

export function assertPrimaryAgentUrl(card: Record<string, unknown>) {
  assert.ok(primaryAgentUrl(card as any), "should have a primary agent URL");
}

export function isUrlPart(part: Record<string, unknown>): boolean {
  const content = part.content as { $case?: string } | undefined;
  return content?.$case === "url" || typeof part.url === "string";
}

export function isTextPart(part: Record<string, unknown>): boolean {
  const content = part.content as { $case?: string } | undefined;
  return content?.$case === "text" || typeof part.text === "string";
}

export function partUrlFromJson(part: Record<string, unknown>): string {
  const content = part.content as { $case?: string; value?: string } | undefined;
  if (content?.$case === "url" && typeof content.value === "string") {
    return content.value;
  }
  if (typeof part.url === "string") {
    return part.url;
  }
  const legacyFile = part.file as { uri?: string } | undefined;
  return legacyFile?.uri ?? "";
}

export { TaskState, primaryAgentUrl, primaryProtocolVersion };
