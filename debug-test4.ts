/**
 * 調試 Test 4 - 事件驅動隊列
 */

import { ConnectionPool } from "./src/connection-pool.js";

async function debugTest4() {
  console.log("=== Debug Test 4: Event-driven Queue ===\n");

  const pool = new ConnectionPool({
    maxConnections: 5,
    maxConnectionsPerEndpoint: 2,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  try {
    const endpoint = "http://localhost:18803";

    console.log("Step 1: Acquire first connection");
    const conn1 = await pool.acquire(endpoint);
    console.log(`  conn1.id: ${conn1.id}`);
    console.log(`  Stats: ${JSON.stringify(pool.getStats())}`);

    console.log("\nStep 2: Acquire second connection");
    const conn2 = await pool.acquire(endpoint);
    console.log(`  conn2.id: ${conn2.id}`);
    console.log(`  Stats: ${JSON.stringify(pool.getStats())}`);

    console.log("\nStep 3: Try to acquire third connection (should wait)");
    const conn3Promise = pool.acquire(endpoint);
    console.log(`  Stats after promise: ${JSON.stringify(pool.getStats())}`);

    console.log("\nStep 4: Check waiting requests");
    const stats = pool.getStats();
    console.log(`  waitingRequests: ${stats.waitingRequests}`);
    console.log(`  activeConnections: ${stats.activeConnections}`);
    console.log(`  totalConnections: ${stats.totalConnections}`);

    console.log("\nStep 5: Release conn1");
    pool.release(conn1.id);
    console.log(`  Stats after release: ${JSON.stringify(pool.getStats())}`);

    console.log("\nStep 6: Wait for conn3");
    const conn3 = await conn3Promise;
    console.log(`  conn3.id: ${conn3.id}`);
    console.log(`  conn3 === conn1: ${conn3.id === conn1.id ? "YES" : "NO"}`);
    console.log(`  Stats: ${JSON.stringify(pool.getStats())}`);

    pool.destroy();
  } catch (error) {
    console.error("Error:", error);
    pool.destroy();
    process.exit(1);
  }
}

debugTest4();
