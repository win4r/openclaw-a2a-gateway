import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  orderTransports,
  isRetryableTransportError,
  adaptiveOrderTransports,
  TransportStats,
  type TransportEndpoint,
} from "../src/transport-fallback.js";

// ---------------------------------------------------------------------------
// orderTransports
// ---------------------------------------------------------------------------

describe("orderTransports", () => {
  it("returns correct priority order: JSONRPC > HTTP+JSON > GRPC", () => {
    const input: TransportEndpoint[] = [
      { url: "http://x:50051", transport: "GRPC" },
      { url: "http://x/rest", transport: "HTTP+JSON" },
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
    ];

    const result = orderTransports(input);

    assert.equal(result[0].transport, "JSONRPC");
    assert.equal(result[1].transport, "HTTP+JSON");
    assert.equal(result[2].transport, "GRPC");
  });

  it("preserves order when only one transport exists", () => {
    const input: TransportEndpoint[] = [
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
    ];

    const result = orderTransports(input);

    assert.equal(result.length, 1);
    assert.equal(result[0].transport, "JSONRPC");
  });

  it("appends unknown transports at the end", () => {
    const input: TransportEndpoint[] = [
      { url: "http://x/custom", transport: "WEBSOCKET" },
      { url: "http://x/rest", transport: "HTTP+JSON" },
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
    ];

    const result = orderTransports(input);

    assert.equal(result[0].transport, "JSONRPC");
    assert.equal(result[1].transport, "HTTP+JSON");
    assert.equal(result[2].transport, "WEBSOCKET");
  });

  it("handles empty array", () => {
    const result = orderTransports([]);
    assert.equal(result.length, 0);
  });

  it("handles duplicates correctly", () => {
    const input: TransportEndpoint[] = [
      { url: "http://a/jsonrpc", transport: "JSONRPC" },
      { url: "http://b/jsonrpc", transport: "JSONRPC" },
      { url: "http://a/rest", transport: "HTTP+JSON" },
    ];

    const result = orderTransports(input);

    // Both JSONRPC entries come before HTTP+JSON
    assert.equal(result[0].transport, "JSONRPC");
    assert.equal(result[1].transport, "JSONRPC");
    assert.equal(result[2].transport, "HTTP+JSON");
  });
});

// ---------------------------------------------------------------------------
// isRetryableTransportError
// ---------------------------------------------------------------------------

describe("isRetryableTransportError", () => {
  // -- Retryable errors --

  it("returns true for ECONNREFUSED", () => {
    assert.equal(
      isRetryableTransportError(new Error("connect ECONNREFUSED 127.0.0.1:18800")),
      true,
    );
  });

  it("returns true for ECONNRESET", () => {
    assert.equal(
      isRetryableTransportError(new Error("read ECONNRESET")),
      true,
    );
  });

  it("returns true for ETIMEDOUT", () => {
    assert.equal(
      isRetryableTransportError(new Error("connect ETIMEDOUT 10.0.0.1:443")),
      true,
    );
  });

  it("returns true for fetch failed", () => {
    assert.equal(
      isRetryableTransportError(new Error("fetch failed")),
      true,
    );
  });

  it("returns true for timeout errors", () => {
    assert.equal(
      isRetryableTransportError(new Error("The operation timed out")),
      true,
    );
  });

  it("returns true for DNS / ENOTFOUND errors", () => {
    assert.equal(
      isRetryableTransportError(new Error("getaddrinfo ENOTFOUND example.com")),
      true,
    );
  });

  it("returns true for gRPC UNAVAILABLE", () => {
    assert.equal(
      isRetryableTransportError(new Error("14 UNAVAILABLE: Connection refused")),
      true,
    );
  });

  it("returns true for gRPC DEADLINE_EXCEEDED", () => {
    assert.equal(
      isRetryableTransportError(new Error("4 DEADLINE EXCEEDED")),
      true,
    );
  });

  it("returns true for 500 status code object", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 500, response: { error: "Internal" } }),
      true,
    );
  });

  it("returns true for 502 status code object", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 502, response: { error: "Bad Gateway" } }),
      true,
    );
  });

  it("returns true for 503 status code object", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 503, response: { error: "Unavailable" } }),
      true,
    );
  });

  it("returns true for 429 rate limit", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 429, response: { error: "Too Many Requests" } }),
      true,
    );
  });

  // -- Non-retryable errors --

  it("returns false for 401 Unauthorized", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 401, response: { error: "Unauthorized" } }),
      false,
    );
  });

  it("returns false for 403 Forbidden", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 403, response: { error: "Forbidden" } }),
      false,
    );
  });

  it("returns false for 400 Bad Request", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 400, response: { error: "Bad Request" } }),
      false,
    );
  });

  it("returns false for 404 Not Found", () => {
    assert.equal(
      isRetryableTransportError({ statusCode: 404, response: { error: "Not Found" } }),
      false,
    );
  });

  it("returns false for non-network Error", () => {
    assert.equal(
      isRetryableTransportError(new Error("Invalid argument")),
      false,
    );
  });

  it("returns false for auth-related Error messages", () => {
    assert.equal(
      isRetryableTransportError(new Error("Authentication required")),
      false,
    );
  });

  it("returns false for null", () => {
    assert.equal(isRetryableTransportError(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isRetryableTransportError(undefined), false);
  });

  it("returns false for unknown object shape", () => {
    assert.equal(isRetryableTransportError({ foo: "bar" }), false);
  });
});

// ---------------------------------------------------------------------------
// Integration-style: transport fallback scenario in A2AClient
// ---------------------------------------------------------------------------
// These tests exercise the fallback logic indirectly via the exported helpers,
// simulating what the A2AClient.doSendMessage method does internally.

describe("transport fallback scenario", () => {
  it("first transport fails with connection error, second succeeds", async () => {
    const transports: TransportEndpoint[] = orderTransports([
      { url: "http://peer:8080/jsonrpc", transport: "JSONRPC" },
      { url: "http://peer:8080/rest", transport: "HTTP+JSON" },
    ]);

    const sendResults: Array<{ ok: boolean; error?: string }> = [
      { ok: false, error: "ECONNREFUSED" }, // JSONRPC fails
      { ok: true },                          // REST succeeds
    ];

    let usedTransport: string | undefined;
    let attempts = 0;

    for (let i = 0; i < transports.length; i++) {
      const endpoint = transports[i];
      attempts++;

      const simulated = sendResults[i];
      if (!simulated.ok) {
        const err = new Error(simulated.error!);
        if (isRetryableTransportError(err)) {
          continue; // Fall back to next transport
        }
        // Non-retryable → stop
        break;
      }

      usedTransport = endpoint.transport;
      break;
    }

    assert.equal(attempts, 2);
    assert.equal(usedTransport, "HTTP+JSON");
  });

  it("does not fall back on auth error (401)", async () => {
    const transports: TransportEndpoint[] = orderTransports([
      { url: "http://peer:8080/jsonrpc", transport: "JSONRPC" },
      { url: "http://peer:8080/rest", transport: "HTTP+JSON" },
    ]);

    let attempts = 0;

    for (let i = 0; i < transports.length; i++) {
      attempts++;

      // Simulate 401 on first transport
      const err = { statusCode: 401, response: { error: "Unauthorized" } };
      if (isRetryableTransportError(err)) {
        continue;
      }
      break; // 401 is NOT retryable → stop
    }

    assert.equal(attempts, 1, "should stop after auth error, no fallback");
  });

  it("all transports fail → returns the last error", async () => {
    const transports: TransportEndpoint[] = orderTransports([
      { url: "http://peer:8080/jsonrpc", transport: "JSONRPC" },
      { url: "http://peer:8080/rest", transport: "HTTP+JSON" },
      { url: "http://peer:50051", transport: "GRPC" },
    ]);

    const errors = [
      new Error("ECONNREFUSED"),
      new Error("fetch failed"),
      new Error("UNAVAILABLE"),
    ];

    let lastError: Error | undefined;
    let allFailed = true;

    for (let i = 0; i < transports.length; i++) {
      const err = errors[i];
      lastError = err;

      if (isRetryableTransportError(err)) {
        continue;
      }
      allFailed = false;
      break;
    }

    assert.equal(allFailed, true, "all transports should have failed");
    assert.ok(lastError);
    assert.ok(lastError.message.includes("UNAVAILABLE"));
  });
});

// ---------------------------------------------------------------------------
// TransportStats
// ---------------------------------------------------------------------------

describe("TransportStats", () => {
  it("returns optimistic defaults for unknown transports", () => {
    const stats = new TransportStats();
    assert.equal(stats.successRate("JSONRPC"), 1);
    assert.equal(stats.avgLatency("JSONRPC"), 0);
    assert.equal(stats.getScore("JSONRPC"), 1);
    assert.equal(stats.count("JSONRPC"), 0);
  });

  it("tracks success rate across recorded outcomes", () => {
    const stats = new TransportStats();
    stats.record("JSONRPC", true, 50);
    stats.record("JSONRPC", true, 60);
    stats.record("JSONRPC", false, 100);
    stats.record("JSONRPC", true, 40);

    assert.equal(stats.successRate("JSONRPC"), 0.75); // 3/4
    assert.equal(stats.count("JSONRPC"), 4);
  });

  it("computes average latency from successful calls only", () => {
    const stats = new TransportStats();
    stats.record("REST", true, 100);
    stats.record("REST", false, 5000); // failure — excluded from avg
    stats.record("REST", true, 200);

    assert.equal(stats.avgLatency("REST"), 150); // (100+200)/2
  });

  it("respects sliding window size", () => {
    const stats = new TransportStats(3); // window = 3
    stats.record("GRPC", false, 100); // will be pushed out
    stats.record("GRPC", true, 50);
    stats.record("GRPC", true, 60);
    stats.record("GRPC", true, 70); // pushes out the first failure

    assert.equal(stats.count("GRPC"), 3);
    assert.equal(stats.successRate("GRPC"), 1); // all 3 in window are successes
  });

  it("score penalizes high latency", () => {
    const stats = new TransportStats(20, 1000); // normalizer = 1000ms

    // Fast transport: 50ms avg → latencyFactor ≈ 0.952
    stats.record("FAST", true, 50);
    // Slow transport: 5000ms avg → latencyFactor ≈ 0.167
    stats.record("SLOW", true, 5000);

    assert.ok(stats.getScore("FAST") > stats.getScore("SLOW"));
    // Both have 100% success rate, so difference is purely from latency
    assert.equal(stats.successRate("FAST"), 1);
    assert.equal(stats.successRate("SLOW"), 1);
  });

  it("score penalizes low success rate", () => {
    const stats = new TransportStats();
    // Reliable transport: 100% success
    stats.record("RELIABLE", true, 100);
    stats.record("RELIABLE", true, 100);
    // Flaky transport: 50% success
    stats.record("FLAKY", true, 100);
    stats.record("FLAKY", false, 100);

    assert.ok(stats.getScore("RELIABLE") > stats.getScore("FLAKY"));
  });

  it("clear removes all records", () => {
    const stats = new TransportStats();
    stats.record("JSONRPC", true, 50);
    stats.record("GRPC", false, 100);
    stats.clear();

    assert.equal(stats.count("JSONRPC"), 0);
    assert.equal(stats.count("GRPC"), 0);
    assert.equal(stats.successRate("JSONRPC"), 1); // back to default
  });
});

// ---------------------------------------------------------------------------
// adaptiveOrderTransports
// ---------------------------------------------------------------------------

describe("adaptiveOrderTransports", () => {
  it("orders by score when stats differ", () => {
    const stats = new TransportStats();
    // GRPC has best stats
    stats.record("GRPC", true, 10);
    stats.record("GRPC", true, 15);
    // JSONRPC has worst stats
    stats.record("JSONRPC", false, 500);
    stats.record("JSONRPC", false, 600);
    // HTTP+JSON has medium stats
    stats.record("HTTP+JSON", true, 200);

    const input: TransportEndpoint[] = [
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
      { url: "http://x/rest", transport: "HTTP+JSON" },
      { url: "http://x:50051", transport: "GRPC" },
    ];

    const result = adaptiveOrderTransports(input, stats);
    // GRPC first (highest score), HTTP+JSON second, JSONRPC last (0% success)
    assert.equal(result[0].transport, "GRPC");
    assert.equal(result[1].transport, "HTTP+JSON");
    assert.equal(result[2].transport, "JSONRPC");
  });

  it("falls back to static priority when scores are equal", () => {
    const stats = new TransportStats(); // No records → all score 1.0

    const input: TransportEndpoint[] = [
      { url: "http://x:50051", transport: "GRPC" },
      { url: "http://x/rest", transport: "HTTP+JSON" },
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
    ];

    const result = adaptiveOrderTransports(input, stats);
    // Same order as static priority
    assert.equal(result[0].transport, "JSONRPC");
    assert.equal(result[1].transport, "HTTP+JSON");
    assert.equal(result[2].transport, "GRPC");
  });

  it("does not mutate the input array", () => {
    const stats = new TransportStats();
    stats.record("GRPC", true, 10);

    const input: TransportEndpoint[] = [
      { url: "http://x/jsonrpc", transport: "JSONRPC" },
      { url: "http://x:50051", transport: "GRPC" },
    ];

    const inputCopy = [...input];
    adaptiveOrderTransports(input, stats);
    assert.deepEqual(input, inputCopy); // original unchanged
  });
});
