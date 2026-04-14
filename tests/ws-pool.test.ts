/**
 * GatewayRpcConnectionPool — WebSocket connection pooling tests
 *
 * Validates: reuse, eviction, heartbeat, reconnect, stats, destroy.
 * Uses a mock WebSocket server that speaks the gateway challenge/response protocol.
 *
 * Run: node --import tsx --test tests/ws-pool.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  GatewayRpcConnectionPool,
  type WsPoolConfig,
} from "../src/executor.js";

// ---------------------------------------------------------------------------
// Mock gateway server — minimal protocol simulation
// ---------------------------------------------------------------------------

function setupMockGateway(): Promise<{
  port: number;
  close: () => Promise<void>;
  connectionCount: () => number;
  forceCloseNext: () => void;
}> {
  let wsServer: WebSocketServer;
  let httpServer: http.Server;
  let connections = 0;
  let forceClose = false;

  return new Promise((resolve) => {
    httpServer = http.createServer();
    wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on("connection", (socket) => {
      connections++;
      const shouldClose = forceClose;
      forceClose = false;

      if (shouldClose) {
        socket.close();
        return;
      }

      // Send challenge event like real gateway
      socket.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "test-nonce-" + Date.now() },
      }));

      socket.on("message", (raw) => {
        let frame: any;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (frame.type === "req") {
          // Handle connect
          if (frame.method === "connect") {
            socket.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                scopes: ["operator.admin", "operator.read", "operator.write"],
              },
            }));
            return;
          }

          // Handle echo (heartbeat)
          if (frame.method === "echo") {
            socket.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { ok: true },
            }));
            return;
          }

          // Handle agent
          if (frame.method === "agent") {
            socket.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                status: "accepted",
              },
            }));

            // Then send final result
            setTimeout(() => {
              socket.send(JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: {
                  status: "ok",
                  result: {
                    payloads: [{ text: "Hello from agent" }],
                  },
                },
              }));
            }, 10);
            return;
          }

          // Handle chat.history
          if (frame.method === "chat.history") {
            socket.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                history: [
                  { role: "assistant", content: "History reply" },
                ],
              },
            }));
            return;
          }

          // Default: respond ok
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {},
          }));
        }
      });
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address() as any).port;
      resolve({
        port,
        close: () => new Promise<void>((res) => {
          wsServer.close();
          httpServer.close(() => res());
        }),
        connectionCount: () => connections,
        forceCloseNext: () => { forceClose = true; },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Install mock WebSocket on globalThis (GatewayRpcConnection reads it)
// ---------------------------------------------------------------------------

function installMockWebSocket() {
  (globalThis as any).WebSocket = class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static CLOSING = 2;
    static CONNECTING = 0;

    readyState: number = 0;
    private ws: WsWebSocket | null = null;

    constructor(url: string) {
      this.connect(url);
    }

    private connect(url: string) {
      this.ws = new WsWebSocket(url);
      this.readyState = 0;

      this.ws.on("open", () => {
        this.readyState = 1;
        this.dispatchEvent?.({ type: "open" } as any);
      });

      this.ws.on("message", (data: any) => {
        this.dispatchEvent?.({ type: "message", data: data.toString() } as any);
      });

      this.ws.on("close", () => {
        this.readyState = 3;
        this.dispatchEvent?.({ type: "close" } as any);
      });

      this.ws.on("error", () => {
        this.readyState = 3;
        this.dispatchEvent?.({ type: "error" } as any);
      });
    }

    send(data: string) {
      this.ws?.send(data);
    }

    close() {
      this.readyState = 2;
      this.ws?.close();
    }

    // EventTarget-like interface
    private _listeners: Map<string, Function[]> = new Map();

    addEventListener(type: string, listener: Function) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(listener);
    }

    removeEventListener(type: string, listener: Function) {
      const list = this._listeners.get(type);
      if (list) {
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      }
    }

    dispatchEvent(event: any): boolean {
      const list = this._listeners.get(event.type);
      if (list) {
        for (const fn of list) fn(event);
      }
      return true;
    }
  };
}

function uninstallMockWebSocket() {
  delete (globalThis as any).WebSocket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GatewayRpcConnectionPool", () => {
  let server: Awaited<ReturnType<typeof setupMockGateway>>;

  beforeEach(async () => {
    server = await setupMockGateway();
    installMockWebSocket();
  });

  afterEach(async () => {
    await server.close();
    uninstallMockWebSocket();
  });

  function makeConfig() {
    return {
      port: server.port,
      wsUrl: `ws://127.0.0.1:${server.port}`,
      hooksWakeUrl: "",
      gatewayToken: "test-token",
      gatewayPassword: "",
      hooksToken: "",
    };
  }

  it("creates a new connection on first acquire", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config = makeConfig();

    const conn = await pool.acquire(config);
    assert.ok(conn, "Should return a connection");
    pool.release(config);

    const stats = pool.getStats();
    assert.equal(stats.connections, 1);
    assert.equal(stats.totalAcquires, 1);
    assert.equal(stats.totalReuses, 0);

    pool.destroy();
  });

  it("reuses the same connection on second acquire", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config = makeConfig();

    const conn1 = await pool.acquire(config);
    pool.release(config);

    const initialConnections = server.connectionCount();

    const conn2 = await pool.acquire(config);
    pool.release(config);

    // Should reuse the same WS connection - no new connections on server
    assert.equal(server.connectionCount(), initialConnections, "No new WS connections created for reuse");

    const stats = pool.getStats();
    assert.equal(stats.totalAcquires, 2);
    assert.equal(stats.totalReuses, 1);

    pool.destroy();
  });

  it("creates separate connections for different configs", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config1 = makeConfig();
    const config2 = { ...makeConfig(), gatewayToken: "different-token" };

    const conn1 = await pool.acquire(config1);
    pool.release(config1);

    const conn2 = await pool.acquire(config2);
    pool.release(config2);

    const stats = pool.getStats();
    assert.equal(stats.connections, 2, "Different keys should have separate connections");
    assert.equal(stats.totalAcquires, 2);
    assert.equal(stats.totalReuses, 0);

    pool.destroy();
  });

  it("tracks hit rate correctly", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config = makeConfig();

    // First acquire — miss (cold)
    await pool.acquire(config);
    pool.release(config);

    // Second acquire — hit (reuse)
    await pool.acquire(config);
    pool.release(config);

    // Third acquire — hit (reuse)
    await pool.acquire(config);
    pool.release(config);

    const stats = pool.getStats();
    assert.equal(stats.totalAcquires, 3);
    assert.equal(stats.totalReuses, 2);
    assert.ok(Math.abs(stats.hitRate - 2 / 3) < 0.01, `hitRate should be ~0.667, got ${stats.hitRate}`);

    pool.destroy();
  });

  it("evicts idle connections after idleTimeoutMs", async () => {
    const pool = new GatewayRpcConnectionPool({
      idleTimeoutMs: 200,  // very short for test
      heartbeatIntervalMs: 999_999, // disable heartbeat for eviction test
    });
    const config = makeConfig();

    await pool.acquire(config);
    pool.release(config);

    assert.equal(pool.getStats().connections, 1, "Connection should be in pool after release");

    // Wait for eviction timer to fire
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(pool.getStats().connections, 0, "Connection should be evicted after idle timeout");

    pool.destroy();
  });

  it("resets eviction timer on release", async () => {
    const pool = new GatewayRpcConnectionPool({
      idleTimeoutMs: 300,
      heartbeatIntervalMs: 999_999,
    });
    const config = makeConfig();

    await pool.acquire(config);
    pool.release(config);

    // After 150ms, re-acquire and release (resets eviction timer)
    await new Promise((r) => setTimeout(r, 150));
    await pool.acquire(config);
    pool.release(config);

    // After another 200ms — would have been evicted if timer wasn't reset
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pool.getStats().connections, 1, "Connection should still be in pool — timer was reset");

    // Wait for full eviction from the reset point
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pool.getStats().connections, 0, "Connection should be evicted after reset timeout");

    pool.destroy();
  });

  it("rejects acquire after destroy", async () => {
    const pool = new GatewayRpcConnectionPool();
    pool.destroy();

    await assert.rejects(
      async () => pool.acquire(makeConfig()),
      /destroyed/,
    );
  });

  it("destroy closes all connections", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config1 = makeConfig();
    const config2 = { ...makeConfig(), gatewayToken: "other" };

    await pool.acquire(config1);
    pool.release(config1);
    await pool.acquire(config2);
    pool.release(config2);

    assert.equal(pool.getStats().connections, 2);

    pool.destroy();

    assert.equal(pool.getStats().connections, 0);
  });

  it("double destroy is safe", () => {
    const pool = new GatewayRpcConnectionPool();
    pool.destroy();
    pool.destroy(); // should not throw
  });

  it("reconnects when existing connection is dead", async () => {
    const pool = new GatewayRpcConnectionPool({
      idleTimeoutMs: 5_000,
      maxReconnectAttempts: 1,
    });
    const config = makeConfig();

    const conn1 = await pool.acquire(config);
    pool.release(config);

    const connectionsBefore = server.connectionCount();

    // Force-close the underlying connection
    const socket = (conn1 as any).socket;
    if (socket) socket.close();

    // Wait for close to propagate
    await new Promise((r) => setTimeout(r, 50));

    // Next acquire should detect dead connection and create a new one
    const conn2 = await pool.acquire(config);
    pool.release(config);

    // Server should have received a new connection
    assert.ok(server.connectionCount() > connectionsBefore, "New WS connection created after reconnect");

    const stats = pool.getStats();
    assert.equal(stats.connections, 1);

    pool.destroy();
  });

  it("reports correct active/idle counts", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config = makeConfig();

    // Acquire — active
    await pool.acquire(config);
    let stats = pool.getStats();
    assert.equal(stats.activeConnections, 1);
    assert.equal(stats.idleConnections, 0);

    // Release — idle
    pool.release(config);
    stats = pool.getStats();
    assert.equal(stats.activeConnections, 0);
    assert.equal(stats.idleConnections, 1);

    pool.destroy();
  });

  it("reuses connection for many sequential dispatches", async () => {
    const pool = new GatewayRpcConnectionPool({ idleTimeoutMs: 5_000 });
    const config = makeConfig();

    // Simulate 10 sequential dispatches
    for (let i = 0; i < 10; i++) {
      await pool.acquire(config);
      pool.release(config);
    }

    // Should have created only 1 connection for the pool
    // (1 WS connection on the server side, since we reuse the same one)
    const stats = pool.getStats();
    assert.equal(stats.connections, 1, "Pool should have 1 connection");
    assert.equal(stats.totalAcquires, 10);
    assert.equal(stats.totalReuses, 9);
    assert.ok(stats.hitRate >= 0.89, `hitRate should be ~0.9, got ${stats.hitRate}`);

    pool.destroy();
  });
});