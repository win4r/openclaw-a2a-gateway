/**
 * Connection Pool Benchmark
 *
 * Tests performance improvement with connection pooling.
 */

import { ConnectionPool } from "../src/connection-pool.js";

async function runBenchmark(iterations: number = 1000): Promise<void> {
  const endpoint = "http://localhost:18800";

  console.log("=== Connection Pool Benchmark ===");
  console.log(`Iterations: ${iterations}`);
  console.log();

  // Test 1: No pooling (sequential)
  console.log("Test 1: No pooling (sequential)");
  const start1 = Date.now();

  for (let i = 0; i < iterations; i++) {
    // Simulate message send without pooling
    const conn = {
      id: `conn_${i}`,
      endpoint,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true,
    };

    // Simulate send delay (1ms)
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  const end1 = Date.now();
  const time1 = end1 - start1;
  console.log(`Total time: ${time1}ms`);
  console.log(`Average latency: ${(time1 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time1 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Test 2: With connection pool
  console.log("Test 2: With connection pool");
  const pool = new ConnectionPool({
    maxConnections: 10,
  });

  const start2 = Date.now();

  for (let i = 0; i < iterations; i++) {
    const connection = await pool.acquire(endpoint);

    // Simulate send delay (1ms)
    await new Promise(resolve => setTimeout(resolve, 1));

    pool.release(connection.id);
  }

  const end2 = Date.now();
  const time2 = end2 - start2;
  console.log(`Total time: ${time2}ms`);
  console.log(`Average latency: ${(time2 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time2 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Test 3: Concurrent requests
  console.log("Test 3: Concurrent requests (50 concurrent)");
  const pool2 = new ConnectionPool({
    maxConnections: 10,
  });

  const start3 = Date.now();

  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      (async () => {
        const connection = await pool2.acquire(endpoint);
        await new Promise(resolve => setTimeout(resolve, 1));
        pool2.release(connection.id);
      })()
    );
  }

  await Promise.all(promises);

  const end3 = Date.now();
  const time3 = end3 - start3;
  console.log(`Total time: ${time3}ms`);
  console.log(`Average latency: ${(time3 / 50).toFixed(2)}ms`);
  console.log(`Throughput: ${(50 / time3 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Statistics
  const stats = pool2.getStats();
  console.log("=== Pool Statistics ===");
  console.log(`Total connections: ${stats.totalConnections}`);
  console.log(`Active connections: ${stats.activeConnections}`);
  console.log(`Idle connections: ${stats.idleConnections}`);
  console.log(`Max connections: ${stats.maxConnections}`);
  console.log();

  // Performance comparison
  console.log("=== Performance Comparison ===");
  const latencyImprovement = ((time1 - time2) / time1 * 100).toFixed(1);
  const throughputImprovement = ((iterations / time2 - iterations / time1) / (iterations / time1) * 100).toFixed(1);

  console.log(`Latency improvement: ${latencyImprovement}%`);
  console.log(`Throughput improvement: ${throughputImprovement}%`);
  console.log();

  pool.destroy();
  pool2.destroy();
}

// Run benchmark if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmark(1000).catch(console.error);
}

export { runBenchmark };
