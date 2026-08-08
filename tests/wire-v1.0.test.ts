/**
 * A2A v1.0 wire-format contract test
 *
 * Purpose: prove the v1.0 SDK (@a2a-js/sdk ^1.0.1) can act as both server
 * and client for the v1.0 wire format we want this fork to speak.
 *
 * Why this test exists (pre-port):
 *   The fork is currently pinned to @a2a-js/sdk ^0.3.13. When Phronesis
 *   (Hermes A2A plugin, v1.0) calls the live Doxa (this fork, v0.3),
 *   Doxa rejects with "Method not found: SendMessage" — the v1.0
 *   method name on a v0.3 server. This test exercises the v1.0 path
 *   end-to-end using the SDK we'll bump to in phase 3, so we have a
 *   failing test that the SDK upgrade must turn green.
 *
 * Pass criteria (the v1.0 contract):
 *   1. Agent Card served at /.well-known/agent-card.json
 *      - protocolVersion === "1.0"
 *      - supportedInterfaces[].protocolBinding === "JSONRPC"
 *   2. Client.sendMessage generates a JSON-RPC envelope with
 *      method === "SendMessage" (not "message/send")
 *   3. Server responds with a v1.0 result the client can parse
 *   4. The full round-trip (card fetch + send + reply) works over HTTP
 *
 * Expected state: PASS once @a2a-js/sdk is bumped to ^1.0.1 and the
 * fork's routes are wired through jsonRpcHandler / agentCardHandler.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import express, { type Express } from "express";
import type { AddressInfo } from "node:net";

import {
  ClientFactory,
  DefaultRequestHandler,
  InMemoryTaskStore,
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
  type AgentCard,
  type AgentExecutor,
  type Message,
  type Task,
} from "@a2a-js/sdk";
// @a2a-js/sdk v1.0 split exports across subpaths in v0.3 — at the time
// of writing the fork is pinned to ^0.3.13, so this test will fail to
// import. Phase 3 bumps the SDK to ^1.0.1 and the test goes green.

// ---------------------------------------------------------------------------
// Test fixture: a minimal AgentExecutor that echoes the user's text back.
// ---------------------------------------------------------------------------

const FIXTURE_CARD: AgentCard = {
  protocolVersion: "1.0",
  name: "v1.0-contract-test",
  description: "Echo agent for A2A v1.0 wire-format contract test",
  version: "1.0.0",
  provider: {
    organization: "psifunctiondev/openclaw-a2a-gateway-v1.0",
    url: "http://localhost",
  },
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      url: "http://localhost/jsonrpc",
    },
  ],
  capabilities: {
    extendedAgentCard: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [
    {
      id: "echo",
      name: "echo",
      description: "Echoes the user's text back",
      tags: ["test"],
    },
  ],
};

class EchoExecutor implements AgentExecutor {
  async execute(
    requestContext: any,
    eventBus: any,
  ): Promise<void> {
    const userMessage: Message = requestContext.userMessage;
    const textPart = (userMessage.parts ?? []).find(
      (p: any) => p.kind === "text" || typeof p.text === "string",
    );
    const inputText = textPart?.text ?? "(empty)";

    const task: Task = {
      kind: "task",
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: `reply-${Date.now()}`,
          role: "agent",
          parts: [{ kind: "text", text: `echo: ${inputText}` }],
          contextId: requestContext.contextId,
          taskId: requestContext.taskId,
        },
        timestamp: new Date().toISOString(),
      },
    };
    eventBus.finished(task);
  }

  async cancelTask(_taskId: string, _context: any): Promise<void> {
    /* no-op for echo */
  }
}

// ---------------------------------------------------------------------------
// Test harness: spin up a v1.0 server on an ephemeral port.
// ---------------------------------------------------------------------------

interface Harness {
  port: number;
  baseUrl: string;
  cardUrl: string;
  jsonRpcUrl: string;
}

async function bootHarness(): Promise<Harness> {
  const executor = new EchoExecutor();
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    FIXTURE_CARD,
    taskStore,
    executor,
  );

  const app: Express = express();
  app.use(express.json());

  // Canonical v1.0 card path + legacy v0.3 alias (per SDK convention).
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: async () => FIXTURE_CARD }),
  );
  app.use(
    "/.well-known/agent.json",
    agentCardHandler({ agentCardProvider: async () => FIXTURE_CARD }),
  );

  // JSON-RPC route. legacyCompat off — this test is a pure v1.0 contract.
  app.use(
    "/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    cardUrl: `${baseUrl}/.well-known/agent-card.json`,
    jsonRpcUrl: `${baseUrl}/jsonrpc`,
  };
}

describe("A2A v1.0 wire-format contract", () => {
  let harness: Harness;

  before(async () => {
    harness = await bootHarness();
  });

  it("serves an Agent Card with v1.0 protocolVersion at the canonical path", async () => {
    const res = await globalThis.fetch(harness.cardUrl);
    assert.equal(res.status, 200, "agent card must respond 200");
    const card = (await res.json()) as AgentCard;
    assert.equal(card.protocolVersion, "1.0", "must be v1.0");
    assert.ok(Array.isArray(card.supportedInterfaces), "supportedInterfaces must be an array");
    assert.ok(card.supportedInterfaces.length > 0, "supportedInterfaces must be non-empty");
    const jsonrpcIface = card.supportedInterfaces.find(
      (i) => i.protocolBinding === "JSONRPC",
    );
    assert.ok(jsonrpcIface, "must advertise a JSONRPC supportedInterface");
    assert.equal(jsonrpcIface?.protocolVersion, "1.0");
  });

  it("v1.0 server accepts method 'SendMessage' and rejects v0.3 'message/send'", async () => {
    // Positive: v1.0 method name must be accepted.
    const direct = await globalThis.fetch(harness.jsonRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-1",
        method: "SendMessage", // the v1.0 method name
        params: {
          message: {
            kind: "message",
            messageId: "probe-msg-1",
            role: "user",
            parts: [{ kind: "text", text: "hello v1.0" }],
          },
        },
      }),
    });
    assert.equal(direct.status, 200, "v1.0 SendMessage must be accepted");
    const json = (await direct.json()) as any;
    assert.ok(json.result, "v1.0 response must have a result");
    assert.ok(!json.error, `v1.0 response must not be an error: ${JSON.stringify(json.error)}`);

    // Negative: v0.3 method name must be rejected with method-not-found.
    // Proves the server is truly v1.0, not dual-stacked.
    const legacy = await globalThis.fetch(harness.jsonRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-2",
        method: "message/send", // v0.3 method name
        params: {
          message: {
            kind: "message",
            messageId: "probe-msg-2",
            role: "user",
            parts: [{ kind: "text", text: "hello v0.3" }],
          },
        },
      }),
    });
    const legacyJson = (await legacy.json()) as any;
    assert.ok(legacyJson.error, "v0.3 method name must be rejected by a v1.0 server");
    assert.equal(legacyJson.error.code, -32601, "must surface as method-not-found");
  });

  it("v1.0 client can complete a full round-trip via ClientFactory", async () => {
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(harness.cardUrl);

    const result = await (client as any).sendMessage({
      message: {
        kind: "message",
        messageId: `msg-${Date.now()}`,
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
      },
    });

    // v1.0 SDK returns Message | Task. Our EchoExecutor publishes a Task.
    assert.ok(result, "client must receive a result");
    assert.equal((result as any).kind, "task", "echo executor should return a task");
    const task = result as Task;
    assert.equal(task.status.state, "completed");
    const reply = task.status.message?.parts?.find((p: any) => p.kind === "text") as any;
    assert.ok(reply, "reply must contain a text part");
    assert.match(reply.text, /echo: hello/, "echo executor must echo the input");
  });
});
