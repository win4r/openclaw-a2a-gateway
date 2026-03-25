/**
 * 調試測試腳本 - 查看具體問題
 */

import { ConnectionPool } from "./src/connection-pool.js";

async function debugTest() {
  console.log("=== Debug Test 3 ===\n");

  const pool = new ConnectionPool({
    maxConnections: 5,
    maxConnectionsPerEndpoint: 2,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  try {
    console.log("Creating connection 1 for localhost:18800");
    const conn1 = await pool.acquire("http://localhost:18800");
    console.log(`  conn1.id: ${conn1.id}`);
    console.log(`  pool.getStats(): ${JSON.stringify(pool.getStats())}`);

    console.log("\nCreating connection 2 for localhost:18801");
    const conn2 = await pool.acquire("http://localhost:18801");
    console.log(`  conn2.id: ${conn2.id}`);
    console.log(`  pool.getStats(): ${JSON.stringify(pool.getStats())}`);

    console.log("\nCreating connection 3 for localhost:18802");
    const conn3 = await pool.acquire("http://localhost:18802");
    console.log(`  conn3.id: ${conn3.id}`);
    console.log(`  pool.getStats(): ${JSON.stringify(pool.getStats())}`);

    console.log("\nFinal check:");
    const stats = pool.getStats();
    console.log(`  totalConnections: ${stats.totalConnections}`);
    console.log(`  expected: 3`);
    console.log(`  match: ${stats.totalConnections === 3 ? "YES" : "NO"}`);

    pool.destroy();
  } catch (error) {
    console.error("Error:", error);
    pool.destroy();
    process.exit(1);
  }
}

debugTest();
