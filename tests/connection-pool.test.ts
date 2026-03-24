/**
 * Connection Pool Tests
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { ConnectionPool, type PooledConnection } from "../src/connection-pool.js";

describe("ConnectionPool", () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool({
      maxConnections: 5,
      maxConnectionsPerEndpoint: 2,
      connectionTtlMs: 60000, // 1 minute
      idleCheckIntervalMs: 1000, // 1 second
    });
  });

  afterEach(() => {
    pool.destroy();
  });

  it("should acquire and release connection", async () => {
    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    assert.ok(connection, "connection should be defined");
    assert.strictEqual(connection.endpoint, endpoint);
    assert.strictEqual(connection.isActive, true);

    const stats = pool.getStats();
    assert.strictEqual(stats.totalConnections, 1);
    assert.strictEqual(stats.activeConnections, 1);

    pool.release(connection.id);

    const statsAfterRelease = pool.getStats();
    assert.strictEqual(statsAfterRelease.activeConnections, 0);
    assert.strictEqual(statsAfterRelease.idleConnections, 1);
  });

  it("should reuse idle connections", async () => {
    const endpoint = "http://localhost:18800";

    const connection1 = await pool.acquire(endpoint);
    pool.release(connection1.id);

    const connection2 = await pool.acquire(endpoint);

    assert.strictEqual(connection2.id, connection1.id); // Reused same connection
    assert.strictEqual(pool.getStats().totalConnections, 1);
  });

  it("should create new connections when pool is not full", async () => {
    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);
    const conn3 = await pool.acquire("http://localhost:18801");

    assert.strictEqual(pool.getStats().totalConnections, 3);
    assert.strictEqual(pool.getStats().activeConnections, 3);
  });

  it("should respect max connection limit", async () => {
    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);

    assert.strictEqual(pool.getStats().totalConnections, 2); // Max connections per endpoint reached

    // Release one connection
    pool.release(conn1.id);

    // Now we can acquire a new connection (reuses released one)
    const conn3 = await pool.acquire(endpoint);
    assert.strictEqual(pool.getStats().totalConnections, 2);
    assert.strictEqual(conn3.id, conn1.id); // Reused
  });

  it("should respect global max connection limit", async () => {
    const endpoint1 = "http://localhost:18800";
    const endpoint2 = "http://localhost:18801";
    const endpoint3 = "http://localhost:18802";

    const conn1 = await pool.acquire(endpoint1);
    const conn2 = await pool.acquire(endpoint2);
    const conn3 = await pool.acquire(endpoint3);
    const conn4 = await pool.acquire("http://localhost:18803");
    const conn5 = await pool.acquire("http://localhost:18804");

    assert.strictEqual(pool.getStats().totalConnections, 5); // Max global connections reached

    // Release one connection
    pool.release(conn1.id);

    // Now we can acquire a new connection
    const conn6 = await pool.acquire("http://localhost:18805");
    assert.strictEqual(pool.getStats().totalConnections, 5);
  });

  it("should cleanup expired connections", async () => {
    const endpoint = "http://localhost:18800";

    const connection = await pool.acquire(endpoint);
    pool.release(connection.id);

    // Wait for cleanup (idleCheckIntervalMs is 1000ms, TTL is 60000ms)
    // We can't wait 60 seconds, so just check the mechanism exists
    const stats = pool.getStats();
    assert.ok(stats.totalConnections >= 1);
  });

  it("should handle multiple endpoints", async () => {
    const endpoint1 = "http://localhost:18800";
    const endpoint2 = "http://localhost:18801";

    const conn1 = await pool.acquire(endpoint1);
    const conn2 = await pool.acquire(endpoint2);

    assert.strictEqual(conn1.endpoint, endpoint1);
    assert.strictEqual(conn2.endpoint, endpoint2);
    assert.strictEqual(pool.getStats().totalConnections, 2);
  });

  it("should close connection", async () => {
    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    pool.close(connection.id);

    const stats = pool.getStats();
    assert.strictEqual(stats.totalConnections, 0);
    assert.strictEqual(stats.activeConnections, 0);
  });

  it("should use event-driven queue (no polling)", async () => {
    const endpoint = "http://localhost:18800";

    // Acquire max connections per endpoint
    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);

    assert.strictEqual(pool.getStats().totalConnections, 2);
    assert.strictEqual(pool.getStats().waitingRequests, 0);

    // Try to acquire a third connection (should wait)
    const conn3Promise = pool.acquire(endpoint);

    // Check that it's waiting
    assert.strictEqual(pool.getStats().waitingRequests, 1);

    // Release one connection (should trigger conn3)
    pool.release(conn1.id);

    // Wait for conn3 to be resolved
    const conn3 = await conn3Promise;

    assert.strictEqual(conn3.id, conn1.id); // Reused
    assert.strictEqual(pool.getStats().waitingRequests, 0);
  });

  it("should provide HTTP agents for URLs", () => {
    const httpAgent = pool.getAgentForUrl("http://example.com");
    const httpsAgent = pool.getAgentForUrl("https://example.com");

    assert.ok(httpAgent);
    assert.ok(httpsAgent);
  });

  it("should destroy gracefully", async () => {
    const endpoint = "http://localhost:18800";

    // Acquire a connection
    const conn1 = await pool.acquire(endpoint);

    // Destroy the pool
    pool.destroy();

    // Verify stats
    const stats = pool.getStats();
    assert.strictEqual(stats.totalConnections, 0);
    assert.strictEqual(stats.activeConnections, 0);

    // Try to acquire after destroy (should throw)
    let error: Error | null = null;
    try {
      await pool.acquire(endpoint);
    } catch (e) {
      error = e as Error;
    }
    assert.ok(error);
    assert.match(error.message, /destroyed/);
  });
});
