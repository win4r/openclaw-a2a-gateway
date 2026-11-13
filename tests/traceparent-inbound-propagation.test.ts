/**
 * Inbound propagation — verifies that an inbound `traceparent` HTTP
 * header on an A2A `message/send` request is lifted into the executor's
 * AsyncLocalStorage scope, which then stamps a fresh child span onto
 * the outbound `agent` req frame going to the local OpenClaw Gateway.
 *
 * This is the missing link that closes the full chain:
 *
 *   Peer A  ──(HTTP traceparent)──▶  Plugin's express handler
 *                                              │
 *                                              │ ALS.run(trace)
 *                                              ▼
 *                                  OpenClawAgentExecutor.dispatch
 *                                              │
 *                                              │ builds child traceparent
 *                                              ▼
 *                                  GatewayRpcConnection.request("agent", …, traceparent)
 *                                              │
 *                                              ▼
 *                                  Mock OpenClaw Gateway  ← sees top-level `traceparent`
 *
 * Run: node --import tsx --test tests/traceparent-inbound-propagation.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { afterEach, describe, it } from "node:test";
import express from "express";

import {
  buildOutboundTraceparent,
  formatTraceparent,
  getActiveUpstreamTrace,
  parseTraceparent,
  resetTraceparentHooks,
  runWithUpstreamTrace,
  isValidTraceparent,
  type W3CTraceContext,
} from "../src/internal/traceparent.js";
import {
  readTraceparentFromMetadata,
  wrapGrpcServiceWithTraceparent,
} from "../src/internal/grpc-traceparent.js";

// ---------------------------------------------------------------------------
// Mock OpenClaw Gateway — captures every `req` frame on the wire.
// ---------------------------------------------------------------------------

interface CapturedReq { type: string; method?: string; traceparent?: string; raw: string }

interface MockGatewayHandle {
  port: number;
  capturedReqFrames: () => CapturedReq[];
  close: () => Promise<void>;
}

function setupMockGateway(): Promise<MockGatewayHandle> {
  const captured: CapturedReq[] = [];
  let wsServer: WebSocketServer;
  let httpServer: http.Server;
  return new Promise((resolve) => {
    httpServer = http.createServer();
    wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "inbound-test-" + Date.now() },
      }));

      socket.on("message", (raw) => {
        const text = raw.toString();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return; }
        if (parsed?.type !== "req") return;

        const frame: CapturedReq = {
          type: parsed.type,
          method: parsed.method,
          traceparent: parsed.traceparent,
          raw: text,
        };
        captured.push(frame);

        if (parsed.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: {
              scopes: ["operator.admin", "operator.read", "operator.write"],
              // Mock a v5 Gateway that supports the top-level
              // `traceparent` field on `req` frames.
              protocol: 5,
            },
          }));
          return;
        }
        if (parsed.method === "agent") {
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: { status: "accepted" },
          }));
          setTimeout(() => {
            socket.send(JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: {
                status: "ok",
                result: { payloads: [{ text: "inbound trace propagation ok" }] },
              },
            }));
          }, 5);
          return;
        }
        if (parsed.method === "chat.history") {
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: { history: [] },
          }));
          return;
        }
        if (parsed.method === "echo") {
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: { ok: true },
          }));
          return;
        }
      });
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address() as any).port;
      resolve({
        port,
        capturedReqFrames: () => captured.filter((f) => f.type === "req"),
        close: () => new Promise<void>((res) => { wsServer.close(); httpServer.close(() => res()); }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers for the inbound HTTP path
// ---------------------------------------------------------------------------

function installMockWebSocket() {
  (globalThis as any).WebSocket = class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 0;
    private ws: WsWebSocket | null = null;
    private _listeners = new Map<string, Function[]>();

    constructor(url: string) {
      this.ws = new WsWebSocket(url);
      this.ws.on("open", () => {
        this.readyState = 1;
        this.dispatchEvent({ type: "open" });
      });
      this.ws.on("message", (data: any) => this.dispatchEvent({ type: "message", data: data.toString() }));
      this.ws.on("close", () => { this.readyState = 3; this.dispatchEvent({ type: "close" }); });
      this.ws.on("error", () => { this.readyState = 3; this.dispatchEvent({ type: "error" }); });
    }

    send(data: string) { this.ws?.send(data); }
    close() { this.readyState = 2; this.ws?.close(); }

    addEventListener(type: string, fn: Function) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: Function) {
      const list = this._listeners.get(type);
      if (list) {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      }
    }
    dispatchEvent(event: any): boolean {
      const list = this._listeners.get(event.type);
      if (list) for (const fn of list) fn(event);
      return true;
    }
  };
}

function uninstallMockWebSocket() {
  delete (globalThis as any).WebSocket;
}

// ---------------------------------------------------------------------------
// Express middleware under test (copied verbatim from index.ts so we can
// exercise it without bringing up the whole plugin)
// ---------------------------------------------------------------------------

function traceparentMiddleware(config: { enabled: boolean } = { enabled: true }) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!config.enabled) { next(); return; }
    const headerValue = req.header("traceparent");
    let parsed: W3CTraceContext | undefined;
    if (typeof headerValue === "string" && headerValue.length > 0) {
      parsed = parseTraceparent(headerValue);
    }
    if (!parsed) { next(); return; }
    runWithUpstreamTrace(parsed, () => next());
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AsyncLocalStorage upstream-trace store (ALS)", () => {
  afterEach(() => {
    resetTraceparentHooks();
  });

  it("runWithUpstreamTrace binds the trace to subsequent async continuations", async () => {
    const parent: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };

    // Outside the scope: nothing
    assert.equal(getActiveUpstreamTrace(), undefined);

    await new Promise<void>((resolve) => {
      runWithUpstreamTrace(parent, async () => {
        // Inside the scope: trace available
        const got = getActiveUpstreamTrace();
        assert.ok(got);
        assert.equal(got.traceId, parent.traceId);
        assert.equal(got.spanId, parent.spanId);

        // Survives a microtask boundary
        await Promise.resolve();
        const gotAfter = getActiveUpstreamTrace();
        assert.ok(gotAfter);
        assert.equal(gotAfter.traceId, parent.traceId);

        // Survives a setTimeout boundary
        await new Promise((r) => setTimeout(r, 1));
        const gotAfterTimer = getActiveUpstreamTrace();
        assert.ok(gotAfterTimer);
        assert.equal(gotAfterTimer.traceId, parent.traceId);

        resolve();
      });
    });

    // Outside again: gone
    assert.equal(getActiveUpstreamTrace(), undefined);
  });

  it("buildOutboundTraceparent honors the ALS scope when no argument is given", async () => {
    const parent: W3CTraceContext = {
      version: "00",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "01",
    };
    await new Promise<void>((resolve) => {
      runWithUpstreamTrace(parent, () => {
        const tp = buildOutboundTraceparent(); // no explicit parent
        assert.ok(tp);
        const parsed = parseTraceparent(tp);
        assert.ok(parsed);
        assert.equal(parsed.traceId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert.notEqual(parsed.spanId, "bbbbbbbbbbbbbbbb");
        resolve();
      });
    });
  });
});

describe("Inbound `traceparent` HTTP header → executor → IPC dispatch", () => {
  let mockGateway: MockGatewayHandle | null = null;

  afterEach(async () => {
    if (mockGateway) {
      await mockGateway.close();
      mockGateway = null;
    }
    uninstallMockWebSocket();
    resetTraceparentHooks();
  });

  it("an inbound HTTP `traceparent` is propagated as the parent of the outbound `agent` WS frame", async () => {
    mockGateway = await setupMockGateway();
    installMockWebSocket();

    // Set up a small standalone express app that:
    //   1. installs our traceparent middleware (the same as index.ts)
    //   2. dispatches the message via the actual executor
    const { OpenClawAgentExecutor } = await import("../src/executor.js");
    const { GatewayConfig } = await import("../src/types.js");

    // Pre-acquire the OpenClaw gateway mock so it has had a chance to start.
    const baseConfig: GatewayConfig = {
      agentCard: { name: "tp-test", description: "", skills: ["chat"] },
      server: { host: "127.0.0.1", port: 0 },
      storage: { tasksDir: "/tmp/tp-test", taskTtlHours: 1, cleanupIntervalMinutes: 1 },
      peers: [],
      security: {
        inboundAuth: "none",
        allowedMimeTypes: ["text/plain"],
        maxFileSizeBytes: 1_000_000,
        maxInlineFileSizeBytes: 1_000_000,
        fileUriAllowlist: [],
        validTokens: new Set<string>(),
      },
      routing: { defaultAgentId: "main", rules: [] },
      limits: { maxConcurrentTasks: 4, maxQueuedTasks: 100 },
      observability: {
        structuredLogs: false,
        exposeMetricsEndpoint: false,
        metricsPath: "/metrics",
        metricsAuth: "none",
        auditLogPath: "/tmp/tp-test-audit.jsonl",
        traceparent: { enabled: true },
      },
      resilience: {
        healthCheck: { enabled: false, intervalMs: 30000, timeoutMs: 5000 },
        retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
        circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
      },
      discovery: { enabled: false, serviceName: "_a2a._tcp.local", refreshIntervalMs: 30000, mergeWithStatic: true },
      advertise: { enabled: false, serviceName: "_a2a._tcp.local", ttl: 120 },
      timeouts: { agentResponseTimeoutMs: 5_000 },
    };

    const api = {
      config: { gateway: { port: mockGateway.port } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as any;

    const executor = new OpenClawAgentExecutor(api, baseConfig);

    const app = express();
    app.use(traceparentMiddleware({ enabled: true }));
    app.post("/a2a/dispatch", express.json(), async (req, res) => {
      // Pretend to be an A2A inbound handler — call the executor with the body.
      const published: any[] = [];
      const bus = {
        publish(event: unknown) { published.push(event); },
        finished() {},
      } as any;
      try {
        await executor.execute({
          taskId: req.body?.taskId ?? "task-inbound",
          contextId: req.body?.contextId ?? "ctx-inbound",
          userMessage: {
            kind: "message",
            messageId: "msg-inbound",
            role: "user",
            parts: [{ kind: "text", text: req.body?.text ?? "inbound trace test" }],
          },
        } as any, bus);
        res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const httpPort = (server.address() as any).port;

    try {
      const UPSTREAM_TP = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
      const response = await fetch(`http://127.0.0.1:${httpPort}/a2a/dispatch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "traceparent": UPSTREAM_TP,
        },
        body: JSON.stringify({ taskId: "task-inbound-1", contextId: "ctx-inbound-1", text: "hello trace" }),
      });
      assert.equal(response.status, 200);

      // Wait for the WS frame to land on the mock gateway
      await new Promise((r) => setTimeout(r, 100));

      const agentFrames = mockGateway.capturedReqFrames().filter((f) => f.method === "agent");
      assert.ok(agentFrames.length >= 1, "expected at least one `agent` frame on the wire");
      const tp = agentFrames[0].traceparent;
      assert.ok(tp, "outbound `agent` frame must have top-level `traceparent`");
      const parsed = parseTraceparent(tp);
      assert.ok(parsed);

      // The upstream trace id MUST propagate through unchanged.
      assert.equal(
        parsed.traceId,
        "cccccccccccccccccccccccccccccccc",
        "outbound trace must inherit the inbound traceparent's traceId",
      );

      // The span id MUST be a fresh child (not the upstream span id).
      assert.notEqual(
        parsed.spanId,
        "ddddddddddddddddd",
        "outbound trace must mint a fresh child span id",
      );

      // The frame structure must NOT contain `traceparent` inside `params`.
      const parsedRaw = JSON.parse(agentFrames[0].raw);
      assert.equal(parsedRaw.params?.traceparent, undefined);
    } finally {
      executor.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("gRPC `traceparent` interceptor", () => {
  afterEach(() => {
    resetTraceparentHooks();
  });

  it("readTraceparentFromMetadata returns parsed context for valid headers", async () => {
    const grpc = await import("@grpc/grpc-js");
    const md = new grpc.Metadata();
    md.set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const ctx = readTraceparentFromMetadata(md as any);
    assert.ok(ctx);
    assert.equal(ctx.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(ctx.spanId, "00f067aa0ba902b7");
  });

  it("readTraceparentFromMetadata returns undefined for missing / malformed carriers", async () => {
    const grpc = await import("@grpc/grpc-js");
    const empty = new grpc.Metadata();
    assert.equal(readTraceparentFromMetadata(empty as any), undefined);

    const malformed = new grpc.Metadata();
    malformed.set("traceparent", "not a trace");
    assert.equal(readTraceparentFromMetadata(malformed as any), undefined);

    assert.equal(readTraceparentFromMetadata(undefined), undefined);
  });

  it("wrapGrpcServiceWithTraceparent lifts inbound metadata into ALS for each method", async () => {
    const capturedTpAtCall: string[] = [];

    // Build a fake service: sendMessage is unary, sendStreamingMessage is server-streaming.
    const inner: Record<string, any> = {
      sendMessage(call: any, callback: any) {
        // The handler itself reads the ALS store — if the wrapper worked,
        // we'll see the inbound traceparent here.
        const tp = buildOutboundTraceparent();
        if (tp) capturedTpAtCall.push(tp);
        callback(null, {});
      },
      sendStreamingMessage(call: any) {
        const tp = buildOutboundTraceparent();
        if (tp) capturedTpAtCall.push(tp);
        return (async function* () { /* nothing to yield */ })();
      },
    };

    const wrapped = wrapGrpcServiceWithTraceparent(inner, () => true);
    assert.ok(wrapped.sendMessage);
    assert.ok(wrapped.sendStreamingMessage);

    // Construct a fake `call` object that carries metadata.
    const grpc = await import("@grpc/grpc-js");
    const md = new grpc.Metadata();
    const UPSTREAM_TP = "00-11111111111111111111111111111111-2222222222222222-01";
    md.set("traceparent", UPSTREAM_TP);

    const fakeUnaryCall = { metadata: md };
    await new Promise<void>((resolve) => {
      wrapped.sendMessage(fakeUnaryCall, () => resolve());
    });

    assert.equal(capturedTpAtCall.length, 1);
    const parsed = parseTraceparent(capturedTpAtCall[0]);
    assert.ok(parsed);
    assert.equal(parsed.traceId, "11111111111111111111111111111111", "ALS scope must propagate the inbound trace");
    assert.notEqual(parsed.spanId, "2222222222222222");

    // Streaming path
    const fakeStreamCall = { metadata: md };
    const iter = wrapped.sendStreamingMessage(fakeStreamCall);
    // drain the async iterator so the handler's body finishes
    // (the handler pushes tp synchronously before the async generator yields)
    for await (const _ of iter) { /* drain */ }
    assert.equal(capturedTpAtCall.length, 2);
    const parsed2 = parseTraceparent(capturedTpAtCall[1]);
    assert.ok(parsed2);
    assert.equal(parsed2.traceId, "11111111111111111111111111111111");
  });

  it("wraps every method on the service without leaking ALS scope across calls", async () => {
    // Two consecutive calls, each with a different upstream trace.
    const capturedTpAtCall: string[] = [];
    const inner: Record<string, any> = {
      sendMessage(call: any, callback: any) {
        const tp = buildOutboundTraceparent();
        if (tp) capturedTpAtCall.push(tp);
        callback(null, {});
      },
    };
    const wrapped = wrapGrpcServiceWithTraceparent(inner, () => true);

    const grpc = await import("@grpc/grpc-js");
    const md1 = new grpc.Metadata();
    md1.set("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    await new Promise<void>((resolve) =>
      wrapped.sendMessage({ metadata: md1 }, () => resolve()),
    );

    // Second call WITHOUT a traceparent header — should mint a fresh root.
    await new Promise<void>((resolve) =>
      wrapped.sendMessage({ metadata: new grpc.Metadata() }, () => resolve()),
    );

    assert.equal(capturedTpAtCall.length, 2);
    const first = parseTraceparent(capturedTpAtCall[0]);
    assert.equal(first?.traceId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const second = parseTraceparent(capturedTpAtCall[1]);
    assert.notEqual(second?.traceId, first?.traceId, "scopes must NOT leak across calls");
  });
});
