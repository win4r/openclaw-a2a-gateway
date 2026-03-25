/**
 * 詳細調試測試 - 追蹤整個測試序列
 */

import { ConnectionPool } from "./src/connection-pool.js";

async function detailedDebug() {
  console.log("=== Detailed Debug Test ===\n");

  const pool = new ConnectionPool({
    maxConnections: 5,
    maxConnectionsPerEndpoint: 2,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  try {
    // Test 1: Acquire and release
    console.log("Test 1: Acquire and release");
    const conn1 = await pool.acquire("http://localhost:18800");
    console.log(`  After acquire: ${JSON.stringify(pool.getStats())}`);
    pool.release(conn1.id);
    console.log(`  After release: ${JSON.stringify(pool.getStats())}\n`);

    // Test 2: Reuse idle connection
    console.log("Test 2: Reuse idle connection");
    const conn2 = await pool.acquire("http://localhost:18800");
    console.log(`  conn2.id: ${conn2.id}, conn1.id: ${conn1.id}`);
    console.log(`  Same connection: ${conn2.id === conn1.id ? "YES" : "NO"}`);
    console.log(`  After acquire: ${JSON.stringify(pool.getStats())}`);
    pool.release(conn2.id);
    console.log(`  After release: ${JSON.stringify(pool.getStats())}\n`);

    // Test 3: Create new connections
    console.log("Test 3: Create new connections when pool is not full");
    console.log(`  Before: ${JSON.stringify(pool.getStats())}`);

    const conn3 = await pool.acquire("http://localhost:18800");
    console.log(`  After acquiring localhost:18800: ${JSON.stringify(pool.getStats())}`);

    const conn4 = await pool.acquire("http://localhost:18801");
    console.log(`  After acquiring localhost:18801: ${JSON.stringify(pool.getStats())}`);

    const conn5 = await pool.acquire("http://localhost:18802");
    console.log(`  After acquiring localhost:18802: ${JSON.stringify(pool.getStats())}`);

    console.log(`\n  Final stats: ${JSON.stringify(pool.getStats())}`);
    console.log(`  Expected total: 3, Actual: ${pool.getStats().totalConnections}`);

    pool.destroy();
  } catch (error) {
    console.error("Error:", error);
    pool.destroy();
    process.exit(1);
  }
}

detailedDebug();
