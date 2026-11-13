/**
 * Protocol-version-gated traceparent propagation.
 *
 * Verifies that `GatewayRpcConnection.request()` only stamps a top-level
 * `traceparent` field on `req` frames when the negotiated `protocol` is
 * at least `minTraceparentProtocol` (default 5).  When the Gateway
 * returns no `protocol` field (legacy builds ≤2026.3.x that don't have
 * `traceparent` in their `RequestFrameSchema`), the field MUST be
 * dropped — otherwise the strict `closedObject` validator rejects the
 * frame with:
 *
 *     invalid request frame: at root: unexpected property 'traceparent'
 *
 * Run: node --import tsx --test tests/traceparent-protocol-gating.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  GatewayRpcConnection,
  GatewayRpcConnectionPool,
  type WsPoolConfig,
} from "../src/executor.js";

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// ---------------------------------------------------------------------------
// Configurable mock gateway — let each test pick protocol (or omit it)
// ---------------------------------------------------------------------------

interface MockOpts {
  /** `protocol` value to put in the connect response payload.  Set to
   *  `undefined` to omit the field entirely (legacy behavior). */
  protocol?: number;
  /** Capture every `req` frame on the wire. */
  captured: () => Array<{ method?: string; traceparent?: string; raw: string }>;
  close: () => Promise<void>;
  port: number;
}

async function startMock(opts: { protocol?: number; captureReq?: boolean } = {}): Promise<MockOpts> {
  const captured: Array<{ method?: string; traceparent?: string; raw: string }> = [];
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  return new Promise((resolve) => {
    wsServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "gt-" + Date.now() },
      }));

      socket.on("message", (raw) => {
        const text = raw.toString();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return; }
        if (parsed?.type !== "req") return;

        captured.push({
          method: parsed.method,
          traceparent: parsed.traceparent,
          raw: text,
        });

        if (parsed.method === "connect") {
          const payload: Record<string, unknown> = {
            scopes: ["operator.admin", "operator.read", "operator.write"],
          };
          if (typeof opts.protocol === "number") {
            payload.protocol = opts.protocol;
          }
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload,
          }));
          return;
        }
        if (parsed.method === "agent" || parsed.method === "echo") {
          socket.send(JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: parsed.method === "agent"
              ? { status: "ok", result: { payloads: [{ text: "ok" }] } }
              : { ok: true },
          }));
          return;
        }
      });
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address() as any).port;
      resolve({
        port,
        captured: () => captured.slice(),
        close: () => new Promise<void>((res) => {
          wsServer.close();
          httpServer.close(() => res());
        }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// `globalThis.WebSocket` shim
// ---------------------------------------------------------------------------

function installMockWebSocket() {
  (globalThis as any).WebSocket = class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url: string) {
      this.readyState = 0;
      this._listeners = new Map<string, Function[]>();
      this._ws = new WsWebSocket(url);
      this._ws.on("open", () => { this.readyState = 1; this._emit("open"); });
      this._ws.on("message", (data: any) => this._emit("message", { data: data.toString() }));
      this._ws.on("close", () => { this.readyState = 3; this._emit("close"); });
      this._ws.on("error", () => { this.readyState = 3; this._emit("error"); });
    }
    send(data: string) { this._ws.send(data); }
    close() { this.readyState = 2; this._ws.close(); }
    addEventListener(t: string, fn: Function) {
      if (!this._listeners.has(t)) this._listeners.set(t, []);
      this._listeners.get(t)!.push(fn);
    }
    removeEventListener(t: string, fn: Function) {
      const list = this._listeners.get(t);
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    }
    _emit(t: string, ev: any = {}) {
      const list = this._listeners.get(t);
      if (list) for (const fn of list) fn(ev);
    }
  };
}

function uninstallMockWebSocket() {
  delete (globalThis as any).WebSocket;
}

function baseConfig(port: number, overrides: Record<string, unknown> = {}) {
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}`,
    hooksWakeUrl: "",
    gatewayToken: "test-token",
    gatewayPassword: "",
    hooksToken: "",
    ...overrides,
  };
}

const SAMPLE_TP = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("traceparent protocol-version gating", () => {
  let mock: MockOpts | null = null;

  beforeEach(() => {
    installMockWebSocket();
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
    uninstallMockWebSocket();
  });

  it("legacy Gateway with NO `protocol` field: traceparent is dropped, no surprise rejection", async () => {
    mock = await startMock({ protocol: undefined });

    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    try {
      await conn.request("agent", { message: "hello" }, 5_000, true, SAMPLE_TP);
    } finally {
      conn.close();
    }

    await new Promise((r) => setTimeout(r, 50));

    const frames = mock.captured().filter((f) => f.method === "agent");
    assert.equal(frames.length, 1, "expected one `agent` frame");
    assert.equal(
      frames[0].traceparent,
      undefined,
      "no `protocol` → traceparent MUST be dropped so legacy Gateway doesn't reject with 'unexpected property'",
    );
  });

  it("Gateway that negotiates protocol 5: traceparent is stamped at top level", async () => {
    mock = await startMock({ protocol: 5 });

    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    try {
      await conn.request("agent", { message: "hello" }, 5_000, true, SAMPLE_TP);
    } finally {
      conn.close();
    }

    await new Promise((r) => setTimeout(r, 50));

    const frames = mock.captured().filter((f) => f.method === "agent");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].traceparent, SAMPLE_TP);
    assert.match(frames[0].traceparent!, TRACEPARENT_RE);
  });

  it("Gateway that negotiates protocol 4: traceparent is dropped (below default floor 5)", async () => {
    mock = await startMock({ protocol: 4 });

    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    try {
      await conn.request("agent", { message: "hello" }, 5_000, true, SAMPLE_TP);
    } finally {
      conn.close();
    }

    await new Promise((r) => setTimeout(r, 50));

    const frames = mock.captured().filter((f) => f.method === "agent");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].traceparent, undefined, "negotiated v4 < minProtocolRequired (5) → drop");
  });

  it("operator can lower minTraceparentProtocol to 3 to enable stamping on v3+", async () => {
    mock = await startMock({ protocol: 3 });

    const conn = new GatewayRpcConnection(baseConfig(mock.port, { minTraceparentProtocol: 3 }));
    await conn.connect();
    try {
      await conn.request("agent", { message: "hello" }, 5_000, true, SAMPLE_TP);
    } finally {
      conn.close();
    }

    await new Promise((r) => setTimeout(r, 50));

    const frames = mock.captured().filter((f) => f.method === "agent");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].traceparent, SAMPLE_TP, "lowered floor allows v3+ servers to receive the field");
  });

  it("the connect frame's `maxProtocol` field is the bumped value (5 by default)", async () => {
    mock = await startMock({ protocol: 5 });

    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    conn.close();

    await new Promise((r) => setTimeout(r, 50));

    const connectFrame = mock.captured().find((f) => f.method === "connect");
    assert.ok(connectFrame);
    const parsed = JSON.parse(connectFrame.raw);
    assert.equal(parsed.params.maxProtocol, 5, "default maxProtocol bumped to 5");
    assert.equal(parsed.params.minProtocol, 3, "minProtocol stays 3 for legacy compat");
  });

  it("operator can override `maxProtocol` via runtime config", async () => {
    mock = await startMock({ protocol: 7 });

    const conn = new GatewayRpcConnection(baseConfig(mock.port, { maxProtocol: 7 }));
    await conn.connect();
    try {
      await conn.request("echo", {}, 5_000, false, SAMPLE_TP);
    } finally {
      conn.close();
    }

    await new Promise((r) => setTimeout(r, 50));

    const connectFrame = mock.captured().find((f) => f.method === "connect");
    const parsed = JSON.parse(connectFrame!.raw);
    assert.equal(parsed.params.maxProtocol, 7);
  });

  it("getNegotiatedProtocol reflects the value from the connect response", async () => {
    mock = await startMock({ protocol: 5 });
    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    try {
      assert.equal(conn.getNegotiatedProtocol(), 5);
    } finally {
      conn.close();
    }
  });

  it("getNegotiatedProtocol stays `undefined` when no `protocol` field is returned (legacy)", async () => {
    mock = await startMock({ protocol: undefined });
    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    try {
      assert.equal(conn.getNegotiatedProtocol(), undefined);
    } finally {
      conn.close();
    }
  });

  it("per-connection isolation: a v5 connection co-exists with a legacy one in the same pool", async () => {
    const v5 = await startMock({ protocol: 5 });
    const legacy = await startMock({ protocol: undefined });
    mock = v5; // for afterEach cleanup of one
    const legacyMock = { ...legacy, close: legacy.close, captured: legacy.captured, port: legacy.port };

    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000, heartbeatIntervalMs: 999_999 });

    // Acquire v5 connection
    const connA = await pool.acquire(baseConfig(v5.port));
    // Acquire legacy connection
    const connB = await pool.acquire(baseConfig(legacy.port));

    try {
      const tp1 = "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-1111111111111111-01";
      await connA.request("agent", { message: "v5" }, 5_000, true, tp1);
      pool.release(baseConfig(v5.port));

      const tp2 = "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-2222222222222222-01";
      await connB.request("agent", { message: "legacy" }, 5_000, true, tp2);
      pool.release(baseConfig(legacy.port));
    } finally {
      pool.destroy();
    }

    await new Promise((r) => setTimeout(r, 50));

    const v5Frames = v5.captured().filter((f) => f.method === "agent");
    const legacyFrames = legacy.captured().filter((f) => f.method === "agent");
    assert.equal(v5Frames[0].traceparent, "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-1111111111111111-01", "v5 conn stamps");
    assert.equal(legacyFrames[0].traceparent, undefined, "legacy conn drops it");
    await legacy.close();
  });

  it("traceparent stays off `connect` frames regardless of protocol", async () => {
    mock = await startMock({ protocol: 5 });
    const conn = new GatewayRpcConnection(baseConfig(mock.port));
    await conn.connect();
    conn.close();
    await new Promise((r) => setTimeout(r, 50));

    const connectFrame = mock.captured().find((f) => f.method === "connect");
    assert.ok(connectFrame);
    // OpenClaw Gateway ignores `traceparent` on `connect` per protocol
    // docs, and we MUST NOT pollute the connect frame regardless.
    assert.equal(connectFrame!.traceparent, undefined);
  });
});
