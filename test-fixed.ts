/**
 * 修復的完整測試 - 每個測試獨立運行
 */

import { ConnectionPool } from "./src/connection-pool.js";

let failedTests = 0;
let passedTests = 0;

function assert(condition: any, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passedTests++;
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log("=== Fixed Complete Connection Pool Tests ===\n");

  try {
    // Test 1: Acquire and release
    await test("Test 1: Acquire and release connection", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
        connectionTtlMs: 60000,
        idleCheckIntervalMs: 1000,
      });

      const conn1 = await pool.acquire("http://localhost:18800");
      assert(conn1.id, "Connection should have an ID");
      assert(conn1.endpoint === "http://localhost:18800", "Endpoint should match");
      assert(conn1.isActive === true, "Connection should be active");

      pool.release(conn1.id);

      const stats = pool.getStats();
      assert(stats.activeConnections === 0, "Active connections should be 0 after release");
      assert(stats.idleConnections === 1, "Idle connections should be 1 after release");

      pool.destroy();
    });

    // Test 2: Reuse idle connection
    await test("Test 2: Reuse idle connection", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const conn1 = await pool.acquire("http://localhost:18800");
      pool.release(conn1.id);

      const conn2 = await pool.acquire("http://localhost:18800");
      assert(conn2.id === conn1.id, "Should reuse the same connection");
      assert(pool.getStats().totalConnections === 1, "Should still have only 1 connection");

      pool.destroy();
    });

    // Test 3: Create new connections when pool is not full
    await test("Test 3: Create new connections when pool is not full", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const conn1 = await pool.acquire("http://localhost:18800");
      const conn2 = await pool.acquire("http://localhost:18801");
      const conn3 = await pool.acquire("http://localhost:18802");

      const stats = pool.getStats();
      assert(stats.totalConnections >= 3, "Should have at least 3 total connections");
      assert(stats.activeConnections === 3, "Should have 3 active connections");

      pool.destroy();
    });

    // Test 4: Event-driven queue
    await test("Test 4: Wait for available connection (event-driven queue)", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const endpoint = "http://localhost:18800";

      const conn1 = await pool.acquire(endpoint);
      const conn2 = await pool.acquire(endpoint);

      // Try to acquire a third connection (should wait)
      const conn3Promise = pool.acquire(endpoint);

      // Check that it's waiting
      assert(pool.getStats().waitingRequests === 1, "Should have 1 waiting request");

      // Release one connection (should trigger conn3)
      pool.release(conn1.id);

      // Wait for conn3 to be resolved
      const conn3 = await conn3Promise;

      assert(conn3.id === conn1.id, "Should reuse released connection");
      assert(pool.getStats().waitingRequests === 0, "Should have no waiting requests");
      assert(pool.getStats().activeConnections === 2, "Should have 2 active connections");

      pool.destroy();
    });

    // Test 5: Per-endpoint limit
    await test("Test 5: Per-endpoint limit", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const endpoint = "http://localhost:18900";

      // Acquire max connections per endpoint (2)
      const conn1 = await pool.acquire(endpoint);
      const conn2 = await pool.acquire(endpoint);

      // Should have at least 2 connections
      assert(pool.getStats().totalConnections >= 2, "Should have at least 2 connections");

      pool.destroy();
    });

    // Test 6: Multiple endpoints
    await test("Test 6: Multiple endpoints", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const endpoint1 = "http://localhost:19000";
      const endpoint2 = "http://localhost:19001";

      const conn1 = await pool.acquire(endpoint1);
      const conn2 = await pool.acquire(endpoint2);

      assert(conn1.endpoint === endpoint1, "First connection should match first endpoint");
      assert(conn2.endpoint === endpoint2, "Second connection should match second endpoint");

      pool.destroy();
    });

    // Test 7: Close connection
    await test("Test 7: Close connection", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const conn = await pool.acquire("http://localhost:19100");
      pool.close(conn.id);

      const stats = pool.getStats();
      assert(stats.activeConnections === 0, "Active connections should be 0 after close");

      pool.destroy();
    });

    // Test 8: Get HTTP agents
    await test("Test 8: Get HTTP agents for URLs", () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const httpAgent = pool.getAgentForUrl("http://example.com");
      const httpsAgent = pool.getAgentForUrl("https://example.com");

      assert(httpAgent, "HTTP agent should exist");
      assert(httpsAgent, "HTTPS agent should exist");

      pool.destroy();
    });

    // Test 9: Destroy pool
    await test("Test 9: Destroy pool gracefully", async () => {
      const pool = new ConnectionPool({
        maxConnections: 5,
        maxConnectionsPerEndpoint: 2,
      });

      const conn = await pool.acquire("http://localhost:19200");

      pool.destroy();

      const stats = pool.getStats();
      assert(stats.totalConnections === 0, "Total connections should be 0 after destroy");
      assert(stats.activeConnections === 0, "Active connections should be 0 after destroy");

      // Try to acquire after destroy (should throw)
      let errorThrown = false;
      try {
        await pool.acquire("http://localhost:19201");
      } catch (error) {
        errorThrown = true;
        assert(error instanceof Error && error.message.includes("destroyed"), "Should throw destroyed error");
      }
      assert(errorThrown, "Should throw error when acquiring after destroy");
    });

    console.log("\n=== Test Summary ===");
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${failedTests}`);

    if (failedTests > 0) {
      console.log("\n❌ Some tests failed!");
      process.exit(1);
    } else {
      console.log("\n✅ All tests passed!");
    }
  } catch (error) {
    console.error("\n❌ Unexpected error:", error);
    process.exit(1);
  }
}

runAllTests();
