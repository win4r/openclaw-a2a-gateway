import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PushNotificationStore } from "../src/push-notifications.js";
import type { PushNotificationConfig } from "../src/push-notifications.js";

// ---------------------------------------------------------------------------
// Unit tests — PushNotificationStore in-memory lifecycle
// ---------------------------------------------------------------------------

describe("PushNotificationStore", () => {
  let store: PushNotificationStore;

  beforeEach(() => {
    store = new PushNotificationStore();
  });

  it("register + get returns the config", () => {
    const config: PushNotificationConfig = { url: "https://example.com/hook" };
    store.register("task-1", config);
    const result = store.get("task-1");
    assert.ok(result);
    assert.equal(result.url, "https://example.com/hook");
  });

  it("has returns true for registered tasks", () => {
    store.register("task-1", { url: "https://example.com/hook" });
    assert.equal(store.has("task-1"), true);
    assert.equal(store.has("task-2"), false);
  });

  it("unregister removes the registration", () => {
    store.register("task-1", { url: "https://example.com/hook" });
    store.unregister("task-1");
    assert.equal(store.has("task-1"), false);
    assert.equal(store.get("task-1"), undefined);
  });

  it("unregister on non-existent task is a no-op", () => {
    store.unregister("nonexistent");
    assert.equal(store.size, 0);
  });

  it("size tracks active registrations", () => {
    assert.equal(store.size, 0);
    store.register("task-1", { url: "https://a.com" });
    store.register("task-2", { url: "https://b.com" });
    assert.equal(store.size, 2);
    store.unregister("task-1");
    assert.equal(store.size, 1);
  });

  it("register overwrites existing config for same taskId", () => {
    store.register("task-1", { url: "https://old.com" });
    store.register("task-1", { url: "https://new.com" });
    assert.equal(store.size, 1);
    assert.equal(store.get("task-1")?.url, "https://new.com");
  });

  it("send returns error when no registration exists", async () => {
    const result = await store.send("unknown-task", "completed", { id: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no registration");
  });
});

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

describe("PushNotificationStore event filtering", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;
  let receivedRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    store = new PushNotificationStore();
    receivedRequests = [];

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedRequests.push({ body, headers: req.headers });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("sends notification for matching event", async () => {
    store.register("task-1", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      events: ["completed"],
    });
    const result = await store.send("task-1", "completed", { id: "task-1", status: "completed" });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
  });

  it("does NOT send notification for non-matching event", async () => {
    store.register("task-2", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      events: ["completed"],  // Only "completed"
    });
    const result = await store.send("task-2", "failed", { id: "task-2", status: "failed" });
    assert.equal(result.ok, false);
    assert.match(result.error!, /filtered out/);
    assert.equal(receivedRequests.length, 0);
  });

  it("sends for all terminal events when no filter specified", async () => {
    for (const state of ["completed", "failed", "canceled"]) {
      const taskId = `task-${state}`;
      store.register(taskId, {
        url: `http://127.0.0.1:${webhookPort}/hook`,
        // No events filter — default: all terminal states
      });
      const result = await store.send(taskId, state, { id: taskId });
      assert.equal(result.ok, true, `expected ok for ${state}`);
    }
    assert.equal(receivedRequests.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Webhook POST format
// ---------------------------------------------------------------------------

describe("PushNotificationStore webhook POST format", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;
  let receivedRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    store = new PushNotificationStore();
    receivedRequests = [];

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedRequests.push({ body, headers: req.headers });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true }));
        });
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("POST body has { taskId, state, task }", async () => {
    const taskData = { id: "task-abc", status: { state: "completed" } };
    store.register("task-abc", { url: `http://127.0.0.1:${webhookPort}/hook` });
    await store.send("task-abc", "completed", taskData);

    assert.equal(receivedRequests.length, 1);
    const parsed = JSON.parse(receivedRequests[0].body);
    assert.equal(parsed.taskId, "task-abc");
    assert.equal(parsed.state, "completed");
    assert.deepEqual(parsed.task, taskData);
  });

  it("Content-Type is application/json", async () => {
    store.register("task-ct", { url: `http://127.0.0.1:${webhookPort}/hook` });
    await store.send("task-ct", "completed", { id: "task-ct" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["content-type"], "application/json");
  });

  it("Authorization header is sent when token is configured", async () => {
    store.register("task-auth", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      token: "secret-token-123",
    });
    await store.send("task-auth", "completed", { id: "task-auth" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["authorization"], "Bearer secret-token-123");
  });

  it("No Authorization header when token is not configured", async () => {
    store.register("task-noauth", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
    });
    await store.send("task-noauth", "completed", { id: "task-noauth" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["authorization"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("PushNotificationStore timeout handling", () => {
  let store: PushNotificationStore;
  let slowServer: http.Server;
  let slowPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      slowServer = http.createServer((_req, _res) => {
        // Never respond — will trigger timeout
      });
      slowServer.listen(0, "127.0.0.1", () => {
        const addr = slowServer.address() as { port: number };
        slowPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      slowServer.close(() => resolve());
    });
  });

  it("returns error on timeout without throwing", async () => {
    store.register("task-slow", {
      url: `http://127.0.0.1:${slowPort}/hook`,
    });

    // The store uses a 10s timeout. We can't easily override it,
    // but we can verify that a connection-refused error returns cleanly.
    // For actual timeout testing we'd need to mock, but we verify the
    // error handling path returns {ok: false} without throwing.
    const result = await store.send("task-slow", "completed", { id: "task-slow" });
    // With a non-responding server, this should eventually timeout/abort
    // The important thing is it doesn't throw — it returns a result
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

// ---------------------------------------------------------------------------
// Store cleanup after delivery
// ---------------------------------------------------------------------------

describe("PushNotificationStore cleanup after delivery", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("auto-removes registration after successful delivery", async () => {
    store.register("task-once", { url: `http://127.0.0.1:${webhookPort}/hook` });
    assert.equal(store.has("task-once"), true);

    await store.send("task-once", "completed", { id: "task-once" });
    assert.equal(store.has("task-once"), false);
  });

  it("unregistered tasks do not get notifications", async () => {
    store.register("task-x", { url: `http://127.0.0.1:${webhookPort}/hook` });
    store.unregister("task-x");

    const result = await store.send("task-x", "completed", { id: "task-x" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no registration");
  });
});

// ---------------------------------------------------------------------------
// HTTP error responses
// ---------------------------------------------------------------------------

describe("PushNotificationStore HTTP error responses", () => {
  let store: PushNotificationStore;
  let errorServer: http.Server;
  let errorPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      errorServer = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      });
      errorServer.listen(0, "127.0.0.1", () => {
        const addr = errorServer.address() as { port: number };
        errorPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      errorServer.close(() => resolve());
    });
  });

  it("returns {ok: false} for HTTP 500 responses", async () => {
    store.register("task-err", { url: `http://127.0.0.1:${errorPort}/hook` });
    const result = await store.send("task-err", "completed", { id: "task-err" });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.match(result.error!, /HTTP 500/);
  });

  it("returns {ok: false} for connection refused", async () => {
    store.register("task-refused", { url: "http://127.0.0.1:1/hook" });
    const result = await store.send("task-refused", "completed", { id: "task-refused" });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});
