/**
 * Agent Manager Tests (node:test + assert)
 */

import { describe, test } from "node:test";
import assert from "node:assert";
import { AgentManager } from "../src/agent-manager.js";

describe("AgentManager", () => {
  test("should initialize with default config", () => {
    const agentManager = new AgentManager();

    const stats = agentManager.getStats();
    assert.ok(stats.http);
    assert.ok(stats.https);

    agentManager.destroy();
  });

  test("should initialize with custom config", () => {
    const agentManager = new AgentManager({
      maxSockets: 20,
      maxFreeSockets: 10,
      keepAlive: true,
      keepAliveMsecs: 60000,
      timeout: 60000,
    });

    const httpAgent = agentManager.getHttpAgent();
    assert.strictEqual(httpAgent.maxSockets, 20);
    assert.strictEqual(httpAgent.maxFreeSockets, 10);

    agentManager.destroy();
  });

  test("should return HTTP agent for http URLs", () => {
    const agentManager = new AgentManager();
    const agent = agentManager.getAgent("http://example.com");

    assert.strictEqual(agent, agentManager.getHttpAgent());

    agentManager.destroy();
  });

  test("should return HTTPS agent for https URLs", () => {
    const agentManager = new AgentManager();
    const agent = agentManager.getAgent("https://example.com");

    assert.strictEqual(agent, agentManager.getHttpsAgent());

    agentManager.destroy();
  });

  test("should create pooled fetch function", async () => {
    const agentManager = new AgentManager();

    // Test with URL string
    const fetch1 = agentManager.createPooledFetch.bind(agentManager);
    assert.ok(fetch1);

    agentManager.destroy();
  });

  test("should track agent statistics", () => {
    const agentManager = new AgentManager();

    const stats = agentManager.getStats();

    assert.ok(stats.http);
    assert.ok(stats.http.totalSockets !== undefined);
    assert.ok(stats.http.freeSockets !== undefined);
    assert.ok(stats.http.requests !== undefined);
    assert.ok(stats.http.sockets !== undefined);

    assert.ok(stats.https);
    assert.ok(stats.https.totalSockets !== undefined);
    assert.ok(stats.https.freeSockets !== undefined);
    assert.ok(stats.https.requests !== undefined);
    assert.ok(stats.https.sockets !== undefined);

    agentManager.destroy();
  });

  test("should destroy all agents", () => {
    const agentManager = new AgentManager();

    agentManager.destroy();

    // After destroy, agents should be destroyed
    assert.strictEqual(agentManager.getHttpAgent().maxSockets, 0);
    assert.strictEqual(agentManager.getHttpsAgent().maxSockets, 0);
  });
});
