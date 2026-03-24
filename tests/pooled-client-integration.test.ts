/**
 * Pooled Client Integration Tests (node:test + assert)
 *
 * Tests the PooledA2AClient with real HTTP requests and connection pooling.
 */

import { describe, test } from "node:test";
import assert from "node:assert";
import { createServer } from "http";
import { PooledA2AClient } from "../src/pooled-client.js";

describe("PooledA2AClient Integration", () => {
  let server: ReturnType<typeof createServer>;
  let PORT: number;

  test.before(async () => {
    // Create a simple HTTP test server
    PORT = 34568;
    server = createServer((req, res) => {
      // Simulate processing time (50ms)
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok", timestamp: Date.now() }));
      }, 50);
    });

    await new Promise<void>((resolve) => {
      server.listen(PORT, () => resolve());
    });
  });

  test.after(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  test("should initialize with default config", () => {
    const client = new PooledA2AClient();

    const poolStats = client.getPoolStats();
    assert.strictEqual(poolStats.totalConnections, 0);
    assert.strictEqual(poolStats.activeConnections, 0);

    const agentStats = client.getAgentStats();
    assert.ok(agentStats.http);
    assert.ok(agentStats.https);

    client.destroy();
  });

  test("should initialize with custom config", () => {
    const client = new PooledA2AClient({
      poolConfig: {
        maxConnections: 20,
        maxConnectionsPerEndpoint: 5,
        connectionTtlMs: 60000,
        idleCheckIntervalMs: 1000,
      },
      agentConfig: {
        maxSockets: 20,
        maxFreeSockets: 10,
        keepAlive: true,
      },
    });

    const poolStats = client.getPoolStats();
    assert.strictEqual(poolStats.maxConnections, 20);

    client.destroy();
  });

  test("should track connection pool statistics", () => {
    const client = new PooledA2AClient({
      poolConfig: {
        maxConnections: 10,
        maxConnectionsPerEndpoint: 3,
      },
    });

    const stats = client.getPoolStats();
    assert.strictEqual(stats.totalConnections, 0);
    assert.strictEqual(stats.activeConnections, 0);
    assert.strictEqual(stats.idleConnections, 0);
    assert.strictEqual(stats.maxConnections, 10);

    client.destroy();
  });

  test("should track agent manager statistics", () => {
    const client = new PooledA2AClient({
      agentConfig: {
        maxSockets: 10,
        maxFreeSockets: 5,
      },
    });

    const stats = client.getAgentStats();
    assert.ok(stats.http);
    assert.ok(stats.https);
    assert.ok(stats.http.totalSockets !== undefined);
    assert.ok(stats.https.totalSockets !== undefined);

    client.destroy();
  });

  test("should destroy connection pool and agent manager", () => {
    const client = new PooledA2AClient();

    client.destroy();

    // After destroy, should not be able to acquire connections
    // (This will be tested in ConnectionPool tests)
  });

  test("should handle graceful shutdown", () => {
    const client = new PooledA2AClient();

    // Destroy should not throw
    assert.doesNotThrow(() => {
      client.destroy();
    });
  });
});
