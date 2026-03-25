/**
 * 快速核心測試 - 只測試最重要的功能
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

async function runQuickTests() {
  console.log("=== Quick Core Tests ===\n");

  const pool = new ConnectionPool({
    maxConnections: 5,
    maxConnectionsPerEndpoint: 2,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  try {
    // Test 1: Acquire and release
    await test("Test 1: Acquire and release", async () => {
      const conn = await pool.acquire("http://localhost:18800");
      assert(conn.id, "Connection should have an ID");
      pool.release(conn.id);
      assert(pool.getStats().activeConnections === 0, "Should have 0 active connections");
    });

    // Test 2: Reuse connection
    await test("Test 2: Reuse connection", async () => {
      const conn1 = await pool.acquire("http://localhost:18801");
      pool.release(conn1.id);
      const conn2 = await pool.acquire("http://localhost:18801");
      assert(conn2.id === conn1.id, "Should reuse same connection");
      pool.release(conn2.id);
    });

    // Test 3: Per-endpoint limit
    await test("Test 3: Per-endpoint limit", async () => {
      const conn1 = await pool.acquire("http://localhost:18802");
      const conn2 = await pool.acquire("http://localhost:18802");
      // Should work because maxConnectionsPerEndpoint = 2
      pool.release(conn1.id);
      pool.release(conn2.id);
    });

    // Test 4: Event-driven queue
    await test("Test 4: Event-driven queue", async () => {
      const endpoint = "http://localhost:18803";

      const conn1 = await pool.acquire(endpoint);
      const conn2 = await pool.acquire(endpoint);

      // Try to acquire third (should wait)
      const conn3Promise = pool.acquire(endpoint);

      // Check waiting
      assert(pool.getStats().waitingRequests === 1, "Should have 1 waiting request");

      // Release one
      pool.release(conn1.id);

      // Wait for third
      const conn3 = await conn3Promise;
      assert(conn3.id === conn1.id, "Should reuse released connection");
      assert(pool.getStats().waitingRequests === 0, "Should have 0 waiting requests");

      pool.release(conn2.id);
      pool.release(conn3.id);
    });

    // Test 5: HTTP agents
    await test("Test 5: HTTP agents", () => {
      const httpAgent = pool.getAgentForUrl("http://example.com");
      const httpsAgent = pool.getAgentForUrl("https://example.com");
      assert(httpAgent, "HTTP agent should exist");
      assert(httpsAgent, "HTTPS agent should exist");
    });

    // Test 6: Destroy
    await test("Test 6: Destroy", async () => {
      const conn = await pool.acquire("http://localhost:18804");
      pool.destroy();

      assert(pool.getStats().totalConnections === 0, "Should have 0 total connections");

      let errorThrown = false;
      try {
        await pool.acquire("http://localhost:18805");
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
    pool.destroy();
    process.exit(1);
  }
}

runQuickTests();
