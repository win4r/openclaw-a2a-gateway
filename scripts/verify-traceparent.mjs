#!/usr/bin/env node
/**
 * End-to-end traceparent verification harness.
 *
 * Stands up the four moving parts of the chain in-process so you can
 * confirm, in one command, that an inbound `traceparent` HTTP header on
 * an A2A `message/send` request propagates through to the top-level
 * `traceparent` field on the outbound IPC `agent` frame the plugin
 * sends over the local WebSocket.  No real OpenClaw installation
 * required — the harness uses a tiny mock gateway that speaks the same
 * `connect.challenge` / connect / agent protocol.
 *
 * What it verifies
 * ────────────────
 *   ✔ 1. Inbound HTTP `traceparent` header reaches the executor's
 *        AsyncLocalStorage scope (via the `traceparentMiddleware`).
 *   ✔ 2. Executor picks the ALS as the upstream trace (not A2A
 *        `metadata.traceparent`, not the OTel hook).
 *   ✔ 3. Per-RPC child span id is minted (same traceId, fresh spanId).
 *   ✔ 4. The child span is at the TOP LEVEL of the WS `req` frame, not
 *        inside `params`.
 *   ✔ 5. The child span lands on the same traceId as the inbound
 *        carrier (peer-to-OpenClaw continuity).
 *   ✔ 6. A second request without an upstream header mints a NEW root
 *        trace (no scope leak).
 *   ✔ 7. A malformed upstream value is silently dropped and the dispatch
 *        still succeeds (fallback to fresh root).
 *
 * Usage
 * ─────
 *   $ npm run verify:traceparent                  # auto check
 *   $ node --import tsx scripts/verify-traceparent.mjs --keep
 *                                                  # leave servers up (debug)
 *   $ node --import tsx scripts/verify-traceparent.mjs --upstream 00-...
 *                                                  # custom upstream traceparent
 *   $ node --import tsx scripts/verify-traceparent.mjs --help
 *
 * Exit codes: 0 on success, non-zero on the first failed assertion.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";

import {
  formatTraceparent,
  getActiveUpstreamTrace,
  isValidTraceparent,
  parseTraceparent,
  resetTraceparentHooks,
} from "../src/internal/traceparent.js";
import { traceparentMiddleware } from "../src/internal/inbound-middleware.js";
import { OpenClawAgentExecutor } from "../src/executor.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    keep: false,
    upstream: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    jsonrpcPath: "/a2a/jsonrpc",
    legacyGateway: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") out.keep = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--no-upstream") out.upstream = null;
    else if (arg === "--upstream") out.upstream = argv[++i];
    else if (arg === "--legacy-gateway") out.legacyGateway = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/verify-traceparent.mjs [options]",
      "",
      "Options:",
      "  --keep              leave servers up after the run (debug)",
      "  --upstream <tp>     override the inbound traceparent (default:",
      "                      00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01)",
      "  --no-upstream       send the inbound request WITHOUT a traceparent",
      "                      (script still verifies a fresh root trace is minted)",
      "  --legacy-gateway    pretend the mock OpenClaw gateway predates the",
      "                      `traceparent` schema field (i.e. returns no",
      "                      `protocol` field).  Useful for confirming the",
      "                      silent-fallback path on ≤2026.3.x builds.",
      "  --help, -h          show this message",
      "",
      "Exit 0 on success, non-zero on first failed assertion.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Mock OpenClaw Gateway — minimal `connect.challenge` / connect / agent protocol
// ---------------------------------------------------------------------------

function startMockGateway({ protocol } = {}) {
  const capturedReq = [];
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "verify-" + Date.now() },
    }));
    socket.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (parsed?.type !== "req") return;
      capturedReq.push({
        method: parsed.method,
        traceparent: parsed.traceparent,
        raw,
      });
      if (parsed.method === "connect") {
        // Build the connect response.  When the mock runs in
        // `--legacy-gateway` mode we OMIT the `protocol` field so the
        // plugin's gating kicks in and drops `traceparent` from the
        // outbound frames (the legacy Gateway behavior).  In the default
        // (modern) mode we advertise protocol 5 so the happy path is
        // exercised.
        const payload = {
          scopes: ["operator.admin", "operator.read", "operator.write"],
        };
        if (typeof protocol === "number") {
          payload.protocol = protocol;
        }
        socket.send(JSON.stringify({
          type: "res",
          id: parsed.id,
          ok: true,
          payload,
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
              result: { payloads: [{ text: "verify ok" }] },
            },
          }));
        }, 5);
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address()).port;
      resolve({
        port,
        captured: () => capturedReq.slice(),
        close: () => new Promise((res) => {
          wsServer.close();
          httpServer.close(() => res());
        }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Mock `globalThis.WebSocket` — GatewayRpcConnection reads it from globalThis
// ---------------------------------------------------------------------------

function installMockWebSocket() {
  globalThis.WebSocket = class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.readyState = 0;
      this._listeners = new Map();
      this._ws = new WsWebSocket(url);
      this._ws.on("open", () => { this.readyState = 1; this._emit("open"); });
      this._ws.on("message", (data) => this._emit("message", { data: data.toString() }));
      this._ws.on("close", () => { this.readyState = 3; this._emit("close"); });
      this._ws.on("error", () => { this.readyState = 3; this._emit("error"); });
    }
    send(data) { this._ws.send(data); }
    close() { this.readyState = 2; this._ws.close(); }
    addEventListener(t, fn) {
      if (!this._listeners.has(t)) this._listeners.set(t, []);
      this._listeners.get(t).push(fn);
    }
    removeEventListener(t, fn) {
      const list = this._listeners.get(t);
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    }
    _emit(t, ev = {}) {
      const list = this._listeners.get(t);
      if (list) for (const fn of list) fn(ev);
    }
  };
}

function uninstallMockWebSocket() {
  delete globalThis.WebSocket;
}

// ---------------------------------------------------------------------------
// Mini-plugin — wires the REAL executor + middleware + a tiny A2A façade
// ---------------------------------------------------------------------------

async function startInProcessPlugin({ gatewayPort }) {
  const cfg = {
    agentCard: { name: "verify", description: "", skills: ["chat"] },
    server: { host: "127.0.0.1", port: 0 },
    storage: { tasksDir: "/tmp/a2a-verify", taskTtlHours: 1, cleanupIntervalMinutes: 1 },
    peers: [],
    security: {
      inboundAuth: "none",
      allowedMimeTypes: ["text/plain"],
      maxFileSizeBytes: 1_000_000,
      maxInlineFileSizeBytes: 1_000_000,
      fileUriAllowlist: [],
      validTokens: new Set(),
    },
    routing: { defaultAgentId: "main", rules: [] },
    limits: { maxConcurrentTasks: 4, maxQueuedTasks: 100 },
    observability: {
      structuredLogs: false,
      exposeMetricsEndpoint: false,
      metricsPath: "/metrics",
      metricsAuth: "none",
      auditLogPath: "/tmp/a2a-verify-audit.jsonl",
      traceparent: { enabled: true },
    },
    resilience: {
      healthCheck: { enabled: false, intervalMs: 30000, timeoutMs: 5000 },
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
    },
    discovery: {
      enabled: false,
      serviceName: "_a2a._tcp.local",
      refreshIntervalMs: 30000,
      mergeWithStatic: true,
    },
    advertise: { enabled: false, serviceName: "_a2a._tcp.local", ttl: 120 },
    timeouts: { agentResponseTimeoutMs: 5_000 },
  };

  const api = {
    config: { gateway: { port: gatewayPort } },
    logger: { info() {}, warn() {}, error() {} },
  };

  const executor = new OpenClawAgentExecutor(api, cfg);

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(traceparentMiddleware({ enabled: true }));
  app.post("/a2a/jsonrpc", async (req, res) => {
    const { taskId, contextId, message, id } = req.body || {};
    const bus = { publish() {}, finished() {} };
    const alsTrace = getActiveUpstreamTrace();
    try {
      await executor.execute(
        {
          taskId: taskId || randomUUID(),
          contextId: contextId || randomUUID(),
          userMessage: {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: message || "verify hello" }],
            ...(alsTrace ? { metadata: { traceparent: formatTraceparent(alsTrace) } } : {}),
          },
        },
        bus,
      );
      res.json({ jsonrpc: "2.0", id, result: { ok: true, alsTrace } });
    } catch (err) {
      res.status(500).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  return new Promise((resolve) => {
    const httpServer = http.createServer(app);
    httpServer.listen(0, "127.0.0.1", () => {
      const port = httpServer.address().port;
      resolve({
        port,
        close: () => new Promise((res) => httpServer.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, cond) {
  if (cond) {
    process.stdout.write(`  ✔ ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  ✖ ${label}\n`);
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let upstream;
  if (args.upstream !== null) {
    upstream = parseTraceparent(args.upstream);
    if (!upstream) {
      process.stderr.write(`Invalid --upstream value: ${args.upstream}\n`);
      process.exit(2);
    }
  }

  process.stdout.write("\n=== traceparent end-to-end verification ===\n\n");

  installMockWebSocket();
  resetTraceparentHooks();
  const gateway = await startMockGateway(
    args.legacyGateway
      ? { protocol: undefined }     // silent fallback path
      : { protocol: 5 },           // modern happy path (default)
  );
  const plugin = await startInProcessPlugin({ gatewayPort: gateway.port });

  process.stdout.write(`mock gateway listening on :${gateway.port}\n`);
  process.stdout.write(`plugin HTTP server    on :${plugin.port}\n\n`);

  try {
    // Test 1: inbound HTTP request with a `traceparent` header.
    process.stdout.write("Test 1 — inbound HTTP traceparent → IPC agent frame\n");
    const UPSTREAM_TP = args.upstream ?? null;
    const headers = { "content-type": "application/json" };
    if (UPSTREAM_TP) headers["traceparent"] = UPSTREAM_TP;

    const r1 = await fetchJson(`http://127.0.0.1:${plugin.port}/a2a/jsonrpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        message: "verify hello",
        taskId: "task-vt-1",
        contextId: "ctx-vt-1",
      }),
    });

    check("POST /a2a/jsonrpc returned 200", r1.status === 200);

    await new Promise((r) => setTimeout(r, 100));

    const frames = gateway.captured();
    const agentFrame = frames.find((f) => f.method === "agent");
    check("at least one IPC `agent` frame was captured", Boolean(agentFrame));
    if (!agentFrame) {
      await tearDown({ gateway, plugin, keep: args.keep });
      process.exit(failures === 0 ? 0 : 1);
    }

    if (args.legacyGateway) {
      // In legacy mode, the plugin MUST drop traceparent (or risk
      // getting the entire frame rejected for an unexpected property).
      check(
        "LEGACY Gateway: traceparent field is DROPPED (no 'unexpected property')",
        agentFrame.traceparent === undefined,
      );
    } else {
      check("IPC frame carries `traceparent` at the TOP LEVEL", typeof agentFrame.traceparent === "string");
      check("traceparent is well-formed per W3C", isValidTraceparent(agentFrame.traceparent));
      check("traceparent is NOT inside params", checkFieldAbsentInParams(agentFrame.raw));
    }

    if (agentFrame.traceparent) {
      const parsed = parseTraceparent(agentFrame.traceparent);
      check("traceparent parses to a context", Boolean(parsed));
      if (parsed) {
        if (UPSTREAM_TP) {
          check(
            "outbound trace id INHERITS the inbound upstream trace id",
            parsed.traceId === upstream.traceId,
          );
          check(
            "outbound span id is FRESH (≠ upstream span id)",
            parsed.spanId !== upstream.spanId,
          );
        } else {
          check("fresh root trace has the right length (55 chars)", agentFrame.traceparent.length === 55);
        }
      }
    }

    // Test 2: second request WITHOUT upstream → fresh root, no leak.
    process.stdout.write("\nTest 2 — absent inbound traceparent → fresh root on the wire\n");
    const beforeCount = gateway.captured().length;
    await fetchJson(`http://127.0.0.1:${plugin.port}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        message: "second call",
        taskId: "task-vt-2",
        contextId: "ctx-vt-2",
      }),
    });
    await new Promise((r) => setTimeout(r, 100));

    const allFrames = gateway.captured();
    const newAgentFrames = allFrames
      .slice(beforeCount)
      .filter((f) => f.method === "agent");
    check("second inbound request produced another `agent` frame", newAgentFrames.length >= 1);
    if (newAgentFrames.length >= 1) {
      const tp2 = newAgentFrames[newAgentFrames.length - 1].traceparent;
      if (args.legacyGateway) {
        // Legacy Gateway: gate is closed so the dispatcher must
        // continue to drop traceparent for second call as well.
        check("LEGACY Gateway: traceparent stays dropped on second call", tp2 === undefined);
      } else {
        check("second frame carries a fresh traceparent", isValidTraceparent(tp2));
        if (UPSTREAM_TP && tp2) {
          check(
            "second frame's trace id differs from the first (no leak)",
            parseTraceparent(tp2)?.traceId !== upstream.traceId,
          );
        }
      }
    }

    // Test 3 — Malformed inbound silently dropped.
    process.stdout.write("\nTest 3 — malformed inbound traceparent → silent fallback to fresh root\n");
    const r3 = await fetchJson(`http://127.0.0.1:${plugin.port}/a2a/jsonrpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "traceparent": "this-is-not-a-valid-w3c-traceparent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        message: "malformed tp",
        taskId: "task-vt-3",
        contextId: "ctx-vt-3",
      }),
    });
    await new Promise((r) => setTimeout(r, 100));
    check("malformed inbound still produces a 200 response", r3.status === 200);
    const lastFrame = gateway.captured()
      .filter((f) => f.method === "agent")
      .slice(-1)[0];
    check("the dispatch still produced an `agent` frame", Boolean(lastFrame));
    if (lastFrame) {
      if (args.legacyGateway) {
        // Legacy Gateway: gate is closed regardless of inbound shape;
        // malformed inbound is still silently dropped.
        check(
          "LEGACY Gateway: malformed inbound stays dropped",
          lastFrame.traceparent === undefined,
        );
      } else {
        check(
          "the dispatcher fell back to a fresh root (well-formed traceparent)",
          isValidTraceparent(lastFrame.traceparent),
        );
      }
    }
  } finally {
    await tearDown({ gateway, plugin, keep: args.keep });
  }

  process.stdout.write(
    `\n=== ${failures === 0 ? "PASS" : `FAIL (${failures} assertion(s) failed)`} ===\n\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function checkFieldAbsentInParams(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.params?.traceparent === undefined;
  } catch {
    return false;
  }
}

async function tearDown({ gateway, plugin, keep }) {
  uninstallMockWebSocket();
  if (keep) {
    process.stdout.write(
      `\n(--keep set; servers are still running on :${gateway.port} (WS) and :${plugin.port} (HTTP))\n` +
        `   Inspect WS frames with: websocat ws://127.0.0.1:${gateway.port}\n` +
        `   Probe the plugin with:  curl -H 'traceparent: 00-XX-...-YY-01' http://127.0.0.1:${plugin.port}/a2a/jsonrpc -d '{...}'\n`,
    );
    // Keep the process alive on purpose — ctrl+C to stop.
    await new Promise(() => {});
    return;
  }
  // Force-close: the WebSocket server's `close()` only schedules the
  // shutdown and waits for in-flight clients to drain — without that we
  // can leave a lingering handle and the event loop never goes idle.
  try {
    if (gateway?.close) await Promise.race([gateway.close(), new Promise((r) => setTimeout(r, 500))]);
  } catch {}
  try {
    if (plugin?.close) await Promise.race([plugin.close(), new Promise((r) => setTimeout(r, 500))]);
  } catch {}
}

run().catch((err) => {
  process.stderr.write(`\n${err.stack || err.message || err}\n`);
  process.exit(1);
});
