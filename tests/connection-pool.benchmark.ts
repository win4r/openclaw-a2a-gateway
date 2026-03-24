/**
 * Connection Pool Benchmark (Real HTTP Server)
 *
 * Tests performance improvement with connection pooling using real HTTP server.
 */

import { createServer } from "http";
import { ConnectionPool } from "../src/connection-pool.js";

// Create a simple HTTP test server
function createTestServer(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Simulate processing time (50ms)
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok", timestamp: Date.now() }));
      }, 50);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

async function runRealBenchmark(iterations: number = 100): Promise<void> {
  const PORT = 34567;
  const server = await createTestServer(PORT);
  const endpoint = `http://localhost:${PORT}`;

  console.log("=== Connection Pool Benchmark (Real HTTP) ===");
  console.log(`Iterations: ${iterations}`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log();

  // Test 1: Direct HTTP requests (no pooling)
  console.log("Test 1: Direct HTTP requests (no pooling)");
  const start1 = Date.now();

  for (let i = 0; i < iterations; i++) {
    await fetch(`${endpoint}/test`);
  }

  const end1 = Date.now();
  const time1 = end1 - start1;
  console.log(`Total time: ${time1}ms`);
  console.log(`Average latency: ${(time1 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time1 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Test 2: Connection pool simulation
  console.log("Test 2: Connection pool simulation");
  const pool = new ConnectionPool({
    maxConnections: 10,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  const start2 = Date.now();

  for (let i = 0; i < iterations; i++) {
    const connection = await pool.acquire(endpoint);

    // Simulate HTTP request with keep-alive
    await fetch(`${endpoint}/test`);

    pool.release(connection.id);
  }

  const end2 = Date.now();
  const time2 = end2 - start2;
  console.log(`Total time: ${time2}ms`);
  console.log(`Average latency: ${(time2 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time2 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Test 3: Concurrent requests with connection pool
  console.log("Test 3: Concurrent requests (50 concurrent) with connection pool");
  const pool2 = new ConnectionPool({
    maxConnections: 10,
    maxConnectionsPerEndpoint: 5,
    connectionTtlMs: 60000,
    idleCheckIntervalMs: 1000,
  });

  const start3 = Date.now();

  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      (async () => {
        const connection = await pool2.acquire(endpoint);
        await fetch(`${endpoint}/test`);
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
  if (time1 > 0) {
    const latencyImprovement = ((time1 - time2) / time1 * 100).toFixed(1);
    const throughputImprovement = ((iterations / time2 - iterations / time1) / (iterations / time1) * 100).toFixed(1);

    console.log(`Latency improvement: ${latencyImprovement}%`);
    console.log(`Throughput improvement: ${throughputImprovement}%`);
  }
  console.log();

  // Cleanup
  pool.destroy();
  pool2.destroy();
  server.close();
}

// Run benchmark if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runRealBenchmark(100)
    .then(() => console.log("Benchmark completed successfully"))
    .catch(console.error);
}

export { runRealBenchmark };
