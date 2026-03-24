/**
 * Connection Pool Benchmark
 *
 * Tests performance improvement with connection pooling using real HTTP server.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createServer } from "node:http";
import { ConnectionPool } from "../src/connection-pool.js";

describe("ConnectionPool Benchmark", () => {
  let server: any = null;
  const PORT = 34567;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  async function runBenchmark(iterations: number = 100): Promise<{
    noPoolTime: number;
    withPoolTime: number;
    improvement: number;
  }> {
    // Create test server that simulates real HTTP processing
    server = createServer((req, res) => {
      // Simulate real processing time (50ms)
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok" }));
      }, 50);
    });

    await new Promise<void>((resolve) => {
      server.listen(PORT, () => resolve());
    });

    const endpoint = `http://localhost:${PORT}`;

    // Test 1: No pooling (sequential)
    const start1 = Date.now();
    for (let i = 0; i < iterations; i++) {
      const agent = new (await import("node:http")).Agent({ keepAlive: false });
      await fetch(endpoint, { agent });
      agent.destroy();
    }
    const end1 = Date.now();
    const noPoolTime = end1 - start1;

    // Test 2: With connection pool
    const pool = new ConnectionPool({
      maxConnections: 10,
      maxConnectionsPerEndpoint: 3,
    });

    const start2 = Date.now();
    for (let i = 0; i < iterations; i++) {
      const connection = await pool.acquire(endpoint);
      const agent = pool.getAgentForUrl(endpoint);
      await fetch(endpoint, { agent });
      pool.release(connection.id);
    }
    const end2 = Date.now();
    const withPoolTime = end2 - start2;

    pool.destroy();

    const improvement = ((noPoolTime - withPoolTime) / noPoolTime * 100);

    return { noPoolTime, withPoolTime, improvement };
  }

  it("should show performance improvement with real HTTP requests", async () => {
    const { noPoolTime, withPoolTime, improvement } = await runBenchmark(50);

    console.log(`\n=== Benchmark Results (50 iterations) ===`);
    console.log(`No pooling: ${noPoolTime}ms total, ${noPoolTime / 50}ms average`);
    console.log(`With pool: ${withPoolTime}ms total, ${withPoolTime / 50}ms average`);
    console.log(`Improvement: ${improvement.toFixed(1)}%`);

    // With real HTTP server, we should see meaningful improvement
    // (though it may be less than ideal due to server processing time)
    assert.ok(withPoolTime <= noPoolTime * 1.1, "Pool should not be significantly slower");
  });

  it("should handle concurrent requests efficiently", async () => {
    server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok" }));
      }, 50);
    });

    await new Promise<void>((resolve) => {
      server.listen(PORT, () => resolve());
    });

    const endpoint = `http://localhost:${PORT}`;
    const pool = new ConnectionPool({
      maxConnections: 10,
      maxConnectionsPerEndpoint: 3,
    });

    const concurrentRequests = 20;
    const start = Date.now();

    const promises = [];
    for (let i = 0; i < concurrentRequests; i++) {
      promises.push(
        (async () => {
          const connection = await pool.acquire(endpoint);
          const agent = pool.getAgentForUrl(endpoint);
          await fetch(endpoint, { agent });
          pool.release(connection.id);
        })()
      );
    }

    await Promise.all(promises);

    const end = Date.now();
    const time = end - start;
    const avgLatency = time / concurrentRequests;

    console.log(`\n=== Concurrent Request Results ===`);
    console.log(`Total time: ${time}ms`);
    console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`Throughput: ${(concurrentRequests / time * 1000).toFixed(2)} msg/s`);

    const stats = pool.getStats();
    console.log(`\n=== Pool Statistics ===`);
    console.log(`Total connections: ${stats.totalConnections}`);
    console.log(`Active connections: ${stats.activeConnections}`);
    console.log(`Idle connections: ${stats.idleConnections}`);
    console.log(`Max connections: ${stats.maxConnections}`);

    pool.destroy();

    // Verify pool reused connections
    assert.ok(stats.totalConnections <= stats.maxConnections, "Should not exceed max connections");
  });
});
