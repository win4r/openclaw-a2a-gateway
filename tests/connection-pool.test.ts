import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ConnectionPool } from "../src/connection-pool.js";

describe("ConnectionPool", () => {
  let pool: ConnectionPool;
  let server: http.Server;
  let baseUrl = "";
  let connectionCount = 0;

  beforeEach(async () => {
    connectionCount = 0;
    server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        "connection": "keep-alive",
      });
      res.end("ok");
    });
    server.keepAliveTimeout = 60_000;
    server.on("connection", () => {
      connectionCount += 1;
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;

    pool = new ConnectionPool({
      maxConnections: 5,
      maxConnectionsPerEndpoint: 2,
      connectionTtlMs: 30_000,
    });
  });

  afterEach(async () => {
    pool.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("reuses the same keep-alive socket for sequential requests", async () => {
    const response1 = await pool.fetch(`${baseUrl}/one`);
    assert.equal(await response1.text(), "ok");

    const response2 = await pool.fetch(`${baseUrl}/two`);
    assert.equal(await response2.text(), "ok");

    assert.equal(connectionCount, 1);

    const stats = pool.getStats();
    assert.equal(stats.maxConnections, 5);
    assert.equal(stats.maxConnectionsPerEndpoint, 2);
    assert.ok(stats.idleHttpSockets + stats.activeHttpSockets >= 1);
  });

  it("returns protocol-specific agents", () => {
    assert.ok(pool.getAgentForUrl("http://example.com"));
    assert.ok(pool.getAgentForUrl("https://example.com"));
  });

  it("rejects fetches after destroy", async () => {
    pool.destroy();

    await assert.rejects(
      async () => pool.fetch(`${baseUrl}/destroyed`),
      /destroyed/,
    );
  });
});
