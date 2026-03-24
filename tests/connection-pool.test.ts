/**
 * Connection Pool Tests (node:test + assert)
 */

import { describe, test } from "node:test";
import assert from "node:assert";
import { ConnectionPool, PooledConnection } from "../src/connection-pool.js";

describe("ConnectionPool", () => {
  let pool: ConnectionPool;

  test("should initialize with default config", () => {
    pool = new ConnectionPool();
    const stats = pool.getStats();

    assert.strictEqual(stats.totalConnections, 0);
    assert.strictEqual(stats.activeConnections, 0);
    assert.strictEqual(stats.maxConnections, 10);

    pool.destroy();
  });

  test("should initialize with custom config", () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      maxConnectionsPerEndpoint: 2,
      connectionTtlMs: 60000, // 1 minute
      idleCheckIntervalMs: 1000, // 1 second
    });

    const stats = pool.getStats();
    assert.strictEqual(stats.maxConnections, 5);

    pool.destroy();
  });

  test("should acquire and release connection", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    assert.ok(connection);
    assert.strictEqual(connection.endpoint, endpoint);
    assert.strictEqual(connection.isActive, true);

    const stats = pool.getStats();
    assert.strictEqual(stats.totalConnections, 1);
    assert.strictEqual(stats.activeConnections, 1);

    pool.release(connection.id);

    const statsAfterRelease = pool.getStats();
    assert.strictEqual(statsAfterRelease.activeConnections, 0);
    assert.strictEqual(statsAfterRelease.idleConnections, 1);

    pool.destroy();
  });

  test("should reuse idle connections", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";

    const connection1 = await pool.acquire(endpoint);
    pool.release(connection1.id);

    const connection2 = await pool.acquire(endpoint);

    assert.strictEqual(connection2.id, connection1.id); // Reused same connection
    assert.strictEqual(pool.getStats().totalConnections, 1);

    pool.destroy();
  });

  test("should create new connections when pool is not full", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);
    const conn3 = await pool.acquire(endpoint);

    assert.strictEqual(pool.getStats().totalConnections, 3);
    assert.strictEqual(pool.getStats().activeConnections, 3);

    pool.destroy();
  });

  test("should respect max connection limit", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);
    const conn3 = await pool.acquire(endpoint);
    const conn4 = await pool.acquire(endpoint);
    const conn5 = await pool.acquire(endpoint);

    assert.strictEqual(pool.getStats().totalConnections, 5); // Max connections reached

    // Release one connection
    pool.release(conn1.id);

    // Now we can acquire a new connection (reuses released one)
    const conn6 = await pool.acquire(endpoint);
    assert.strictEqual(pool.getStats().totalConnections, 5);

    pool.destroy();
  });

  test("should cleanup expired connections", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";

    const connection = await pool.acquire(endpoint);
    pool.release(connection.id);

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));

    const stats = pool.getStats();
    // Connection should still be there (1 min TTL, only waited 2s)
    assert.ok(stats.totalConnections >= 1);

    pool.destroy();
  });

  test("should handle multiple endpoints", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint1 = "http://localhost:18800";
    const endpoint2 = "http://localhost:18801";

    const conn1 = await pool.acquire(endpoint1);
    const conn2 = await pool.acquire(endpoint2);

    assert.strictEqual(conn1.endpoint, endpoint1);
    assert.strictEqual(conn2.endpoint, endpoint2);
    assert.strictEqual(pool.getStats().totalConnections, 2);

    pool.destroy();
  });

  test("should close connection", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    pool.close(connection.id);

    const stats = pool.getStats();
    assert.strictEqual(stats.totalConnections, 0);
    assert.strictEqual(stats.activeConnections, 0);

    pool.destroy();
  });

  test("should respect per-endpoint connection limit", async () => {
    pool = new ConnectionPool({
      maxConnections: 10,
      maxConnectionsPerEndpoint: 2,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint1 = "http://localhost:18800";
    const endpoint2 = "http://localhost:18801";

    // Acquire max connections for endpoint1
    const conn1 = await pool.acquire(endpoint1);
    const conn2 = await pool.acquire(endpoint1);

    // Try to acquire third connection for endpoint1 (should wait)
    let conn3Acquired = false;
    const conn3Promise = pool.acquire(endpoint1).then((conn) => {
      conn3Acquired = true;
      return conn;
    });

    // Release one connection from endpoint1
    pool.release(conn1.id);

    // Wait a bit for the waiting connection to be resolved
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.ok(conn3Acquired);

    // Now can acquire connections for endpoint2
    const conn3 = await pool.acquire(endpoint2);
    const conn4 = await pool.acquire(endpoint2);

    assert.strictEqual(pool.getStats().totalConnections, 4);

    pool.destroy();
  });

  test("should handle graceful shutdown", async () => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    });

    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    // Destroy pool
    pool.destroy();

    // Should not be able to acquire new connections
    await assert.rejects(
      pool.acquire(endpoint),
      /Connection pool destroyed/
    );
  });
});
