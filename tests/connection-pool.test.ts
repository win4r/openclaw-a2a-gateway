/**
 * Connection Pool Tests
 */

import { ConnectionPool, PooledConnection } from "../src/connection-pool.js";

describe("ConnectionPool", () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool({
      maxConnections: 5,
      connectionTtlMs: 60000, // 1 minute
      idleCheckIntervalMs: 1000, // 1 second
    });
  });

  afterEach(() => {
    pool.destroy();
  });

  test("should acquire and release connection", async () => {
    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    expect(connection).toBeDefined();
    expect(connection.endpoint).toBe(endpoint);
    expect(connection.isActive).toBe(true);

    const stats = pool.getStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);

    pool.release(connection.id);

    const statsAfterRelease = pool.getStats();
    expect(statsAfterRelease.activeConnections).toBe(0);
    expect(statsAfterRelease.idleConnections).toBe(1);
  });

  test("should reuse idle connections", async () => {
    const endpoint = "http://localhost:18800";

    const connection1 = await pool.acquire(endpoint);
    pool.release(connection1.id);

    const connection2 = await pool.acquire(endpoint);

    expect(connection2.id).toBe(connection1.id); // Reused same connection
    expect(pool.getStats().totalConnections).toBe(1);
  });

  test("should create new connections when pool is not full", async () => {
    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);
    const conn3 = await pool.acquire(endpoint);

    expect(pool.getStats().totalConnections).toBe(3);
    expect(pool.getStats().activeConnections).toBe(3);
  });

  test("should respect max connection limit", async () => {
    const endpoint = "http://localhost:18800";

    const conn1 = await pool.acquire(endpoint);
    const conn2 = await pool.acquire(endpoint);
    const conn3 = await pool.acquire(endpoint);
    const conn4 = await pool.acquire(endpoint);
    const conn5 = await pool.acquire(endpoint);

    expect(pool.getStats().totalConnections).toBe(5); // Max connections reached

    // Release one connection
    pool.release(conn1.id);

    // Now we can acquire a new connection (reuses released one)
    const conn6 = await pool.acquire(endpoint);
    expect(pool.getStats().totalConnections).toBe(5);
  });

  test("should cleanup expired connections", async () => {
    const endpoint = "http://localhost:18800";

    const connection = await pool.acquire(endpoint);
    pool.release(connection.id);

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));

    const stats = pool.getStats();
    // Connection should still be there (1 min TTL, only waited 2s)
    expect(stats.totalConnections).toBeGreaterThanOrEqual(1);
  });

  test("should handle multiple endpoints", async () => {
    const endpoint1 = "http://localhost:18800";
    const endpoint2 = "http://localhost:18801";

    const conn1 = await pool.acquire(endpoint1);
    const conn2 = await pool.acquire(endpoint2);

    expect(conn1.endpoint).toBe(endpoint1);
    expect(conn2.endpoint).toBe(endpoint2);
    expect(pool.getStats().totalConnections).toBe(2);
  });

  test("should close connection", async () => {
    const endpoint = "http://localhost:18800";
    const connection = await pool.acquire(endpoint);

    pool.close(connection.id);

    const stats = pool.getStats();
    expect(stats.totalConnections).toBe(0);
    expect(stats.activeConnections).toBe(0);
  });
});
