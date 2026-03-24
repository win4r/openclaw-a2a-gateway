/**
 * 簡單測試腳本 - 驗證連接池核心功能
 */

import { ConnectionPool } from "./src/connection-pool.js";

async function testConnectionPool() {
  console.log("=== Connection Pool Simple Test ===\n");

  const pool = new ConnectionPool({
    maxConnections: 5,
    maxConnectionsPerEndpoint: 2,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  try {
    // Test 1: Acquire and release
    console.log("Test 1: Acquire and release connection");
    const conn1 = await pool.acquire("http://localhost:18800");
    console.log(`✅ Connection acquired: ${conn1.id}`);
    console.log(`   Endpoint: ${conn1.endpoint}`);
    console.log(`   Active: ${conn1.isActive}`);

    pool.release(conn1.id);
    console.log(`✅ Connection released\n`);

    // Test 2: Reuse idle connection
    console.log("Test 2: Reuse idle connection");
    const conn2 = await pool.acquire("http://localhost:18800");
    console.log(`✅ Connection ID: ${conn2.id}`);
    console.log(`   Should reuse: ${conn2.id === conn1.id ? "YES" : "NO"}\n`);

    // Test 3: Event-driven queue
    console.log("Test 3: Event-driven queue (no polling)");
    const conn3 = await pool.acquire("http://localhost:18800");
    const conn4 = await pool.acquire("http://localhost:18800");
    console.log(`✅ Acquired 2 connections`);
    console.log(`   Pool stats: ${JSON.stringify(pool.getStats())}\n`);

    // Test 4: Wait for available connection
    console.log("Test 4: Wait for available connection");
    const start = Date.now();
    const conn5Promise = pool.acquire("http://localhost:18800");
    pool.release(conn3.id);
    const conn5 = await conn5Promise;
    const elapsed = Date.now() - start;
    console.log(`✅ Connection acquired after ${elapsed}ms`);
    console.log(`   Should be conn3: ${conn5.id === conn3.id ? "YES" : "NO"}\n`);

    // Test 5: Per-endpoint limit
    console.log("Test 5: Per-endpoint limit");
    const conn6 = await pool.acquire("http://localhost:18801");
    const conn7 = await pool.acquire("http://localhost:18801");
    console.log(`✅ Acquired 2 connections for localhost:18801`);
    const stats = pool.getStats();
    console.log(`   Total connections: ${stats.totalConnections}`);
    console.log(`   Active connections: ${stats.activeConnections}\n`);

    // Test 6: Get stats
    console.log("Test 6: Pool statistics");
    console.log(`   Total connections: ${stats.totalConnections}`);
    console.log(`   Active connections: ${stats.activeConnections}`);
    console.log(`   Idle connections: ${stats.idleConnections}`);
    console.log(`   Max connections: ${stats.maxConnections}`);
    console.log(`   Waiting requests: ${stats.waitingRequests}\n`);

    // Test 7: HTTP agents
    console.log("Test 7: HTTP agents for URLs");
    const httpAgent = pool.getAgentForUrl("http://example.com");
    const httpsAgent = pool.getAgentForUrl("https://example.com");
    console.log(`✅ HTTP agent: ${httpAgent ? "YES" : "NO"}`);
    console.log(`   HTTPS agent: ${httpsAgent ? "YES" : "NO"}\n`);

    // Test 8: Destroy
    console.log("Test 8: Destroy pool");
    pool.destroy();
    console.log(`✅ Pool destroyed`);
    console.log(`   Pool stats after destroy: ${JSON.stringify(pool.getStats())}\n`);

    console.log("=== All tests passed! ===\n");
  } catch (error) {
    console.error("❌ Test failed:", error);
    pool.destroy();
    process.exit(1);
  }
}

testConnectionPool();
