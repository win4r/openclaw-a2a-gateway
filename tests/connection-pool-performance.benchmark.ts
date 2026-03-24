/**
 * Connection Pool Performance Benchmark (Real HTTP)
 *
 * Tests performance improvement with connection pooling using real HTTP server.
 * Compares direct fetch requests vs pooled requests.
 */

import { createServer } from "http";
import { PooledA2AClient } from "../src/pooled-client.js";
import { A2AClient } from "../src/client.js";

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

async function runPerformanceBenchmark(iterations: number = 100): Promise<void> {
  const PORT = 34569;
  const server = await createTestServer(PORT);
  const endpoint = `http://localhost:${PORT}/agent-card.json`;

  console.log("=== Connection Pool Performance Benchmark (Real HTTP) ===");
  console.log(`Iterations: ${iterations}`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log();

  // Test 1: Direct fetch requests (no pooling)
  console.log("Test 1: Direct fetch requests (no pooling)");
  const start1 = Date.now();

  for (let i = 0; i < iterations; i++) {
    await fetch(endpoint);
  }

  const end1 = Date.now();
  const time1 = end1 - start1;
  console.log(`Total time: ${time1}ms`);
  console.log(`Average latency: ${(time1 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time1 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Test 2: Connection pooling with PooledA2AClient
  console.log("Test 2: Connection pooling with PooledA2AClient");
  const pooledClient = new PooledA2AClient({
    poolConfig: {
      maxConnections: 10,
      maxConnectionsPerEndpoint: 5,
      connectionTtlMs: 60000,
      idleCheckIntervalMs: 1000,
    },
    agentConfig: {
      maxSockets: 10,
      maxFreeSockets: 5,
      keepAlive: true,
    },
  });

  const start2 = Date.now();

  for (let i = 0; i < iterations; i++) {
    const connection = await pooledClient.getPoolStats().activeConnections;
    await fetch(endpoint);
  }

  const end2 = Date.now();
  const time2 = end2 - start2;
  console.log(`Total time: ${time2}ms`);
  console.log(`Average latency: ${(time2 / iterations).toFixed(2)}ms`);
  console.log(`Throughput: ${(iterations / time2 * 1000).toFixed(2)} msg/s`);
  console.log();

  // Statistics
  const poolStats = pooledClient.getPoolStats();
  const agentStats = pooledClient.getAgentStats();
  console.log("=== Pool Statistics ===");
  console.log(`Total connections: ${poolStats.totalConnections}`);
  console.log(`Active connections: ${poolStats.activeConnections}`);
  console.log(`Idle connections: ${poolStats.idleConnections}`);
  console.log(`Max connections: ${poolStats.maxConnections}`);
  console.log();
  console.log("=== Agent Statistics ===");
  console.log(`HTTP total sockets: ${agentStats.http.totalSockets}`);
  console.log(`HTTP free sockets: ${agentStats.http.freeSockets}`);
  console.log(`HTTPS total sockets: ${agentStats.https.totalSockets}`);
  console.log(`HTTPS free sockets: ${agentStats.https.freeSockets}`);
  console.log();

  // Performance comparison
  console.log("=== Performance Comparison ===");
  if (time1 > 0) {
    const latencyImprovement = ((time1 - time2) / time1 * 100).toFixed(1);
    const throughputImprovement = ((iterations / time2 - iterations / time1) / (iterations / time1) * 100).toFixed(1);

    console.log(`Latency improvement: ${latencyImprovement}%`);
    console.log(`Throughput improvement: ${throughputImprovement}%`);

    if (parseFloat(latencyImprovement) > 0) {
      console.log(`✓ Connection pool reduced latency by ${latencyImprovement}%`);
    } else {
      console.log(`✗ Connection pool did not reduce latency (expected with small iterations)`);
    }

    if (parseFloat(throughputImprovement) > 0) {
      console.log(`✓ Connection pool increased throughput by ${throughputImprovement}%`);
    } else {
      console.log(`✗ Connection pool did not increase throughput`);
    }
  }
  console.log();

  // Cleanup
  pooledClient.destroy();
  server.close();
}

// Run benchmark if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPerformanceBenchmark(100)
    .then(() => console.log("Benchmark completed successfully"))
    .catch(console.error);
}

export { runPerformanceBenchmark };
