/**
 * A2A v1.0 wire-format contract test
 *
 * Purpose: prove the v1.0 SDK (@a2a-js/sdk ^1.0.1) can act as both server
 * and client for the v1.0 wire format we want this fork to speak.
 *
 * Why this test exists (pre-port):
 *   The fork was pinned to @a2a-js/sdk ^0.3.13. When Phronesis
 *   (Hermes A2A plugin, v1.0) calls the live Doxa (this fork, v0.3),
 *   Doxa rejects with "Method not found: SendMessage" — the v1.0
 *   method name on a v0.3 server. This test exercises the v1.0 path
 *   end-to-end using the SDK bumped to ^1.0.1, so it's a failing test
 *   that the SDK upgrade must turn green. With the SDK now at ^1.0.1,
 *   this test verifies the v1.0-only contract (no compat layer).
 *
 * Pass criteria (the v1.0 contract):
 *   1. Agent Card served at /.well-known/agent-card.json
 *      - supportedInterfaces[].protocolBinding === "JSONRPC"
 *      - per-interface protocolVersion === "1.0"
 *   2. Server accepts method "SendMessage", rejects v0.3 "message/send"
 *   3. Full round-trip via ClientFactory works (Message → Task → artifact)
 *
 * Companion: tests/compat-v0_3-part-shape.test.ts covers the dual-stack
 * case (server with legacyCompat accepting both v1.0 and v0.3 inbound).
 *
 * Reference: src/samples/agents/sample-agent/ in @a2a-js/sdk.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";

import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentExecutor,
  type Artifact,
  type Message,
  type Part,
  type Role,
  type Task,
  type TaskState,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  TaskStore,
  AgentEvent,
} from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";

// ---------------------------------------------------------------------------
// Test fixture: a minimal AgentExecutor that echoes the user's text back.
// ---------------------------------------------------------------------------

const FIXTURE_CARD: AgentCard = {
  name: "v1.0-contract-test",
  description: "Echo agent for A2A v1.0 wire-format contract test",
  version: "1.0.0",
  provider: {
    organization: "psifunctiondev/openclaw-a2a-gateway-v1.0",
    url: "http://localhost",
  },
  supportedInterfaces: [
    {
      url: "http://localhost/a2a/jsonrpc",
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "echo",
      name: "echo",
      description: "Echoes the user's text back",
      tags: ["test"],
      examples: [],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      securityRequirements: [],
    },
  ],
  documentationUrl: undefined,
  signatures: [],
};

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function extractText(message: Message): string {
  for (const part of message.parts ?? []) {
    if (part.content?.$case === "text") return part.content.value;
  }
  return "";
}

class EchoExecutor implements AgentExecutor {
  cancelTask = async (_taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    /* no-op */
  };

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const inputText = extractText(userMessage) || "(empty)";

    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    // 1. Initial task snapshot
    const taskSnapshot: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: {
        state: 1 as TaskState, // TASK_STATE_SUBMITTED
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    eventBus.publish(AgentEvent.task(taskSnapshot));

    // 2. Working
    const working: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      status: {
        state: 2 as TaskState, // TASK_STATE_WORKING
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.statusUpdate(working));

    // 3. Artifact with echo
    const replyText = `echo: ${inputText}`;
    const resultArtifact: Artifact = {
      artifactId: uuidv4(),
      name: "Result",
      description: "Echo reply",
      parts: [textPart(replyText)],
      metadata: undefined,
      extensions: [],
    };
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: resultArtifact,
        lastChunk: true,
        append: false,
        metadata: undefined,
      }),
    );

    // 4. Completed
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: 3 as TaskState, // TASK_STATE_COMPLETED
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: undefined,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  port: number;
  baseUrl: string;
  cardUrl: string;
  server: import("node:http").Server;
}

async function bootHarness(): Promise<Harness> {
  // Bind to an ephemeral port to learn which one we got.
  const probe = express();
  const probeServer = probe.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => probeServer.on("listening", () => resolve()));
  const port = (probeServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));

  // Patch the card URL to point at the actual bound port (the v1.0
  // client's outbound transport reads it directly).
  const card: AgentCard = {
    ...FIXTURE_CARD,
    provider: { ...FIXTURE_CARD.provider, url: baseUrl },
    supportedInterfaces: FIXTURE_CARD.supportedInterfaces.map((iface) => ({
      ...iface,
      url: `${baseUrl}/a2a/jsonrpc`,
    })),
  };

  const executor: AgentExecutor = new EchoExecutor();
  const taskStore: TaskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);

  const app: Express = express();

  // Per SDK sample-agent: AGENT_CARD_PATH is ".well-known/agent-card.json"
  // (relative); Express's app.use() needs an absolute path (leading /).
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  // Legacy v0.3 alias path for transition.
  app.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

  // Mount jsonRpcHandler at /a2a/jsonrpc to match the card URL.
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));

  return {
    port,
    baseUrl,
    cardUrl: `${baseUrl}/.well-known/agent-card.json`,
    server,
  };
}

describe("A2A v1.0 wire-format contract", () => {
  let harness: Harness;

  before(async () => {
    harness = await bootHarness();
  });

  after(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  });

  it("serves an Agent Card with v1.0 per-interface protocolVersion", async () => {
    const res = await globalThis.fetch(harness.cardUrl);
    assert.equal(res.status, 200, "agent card must respond 200");
    const card = (await res.json()) as AgentCard;
    assert.ok(card.supportedInterfaces?.length, "supportedInterfaces must be non-empty");
    const jsonrpcIface = card.supportedInterfaces.find(
      (i) => i.protocolBinding === "JSONRPC",
    );
    assert.ok(jsonrpcIface, "must advertise a JSONRPC supportedInterface");
    assert.match(jsonrpcIface!.protocolVersion, /^1\.0/, "JSONRPC interface must be v1.0");
  });

  it("v1.0 server accepts SendMessage and rejects message/send", async () => {
    // Positive: v1.0 method name must be accepted. Send A2A-Version: 1.0
    // explicitly because the SDK defaults to "0.3" when the header is
    // absent (a v0.3 back-compat default), which a v1.0-only server
    // (without legacyCompat) would reject.
    const direct = await globalThis.fetch(`${harness.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-1",
        method: "SendMessage",
        params: {
          message: {
            messageId: "probe-msg-1",
            role: 1,
            parts: [
              {
                content: { $case: "text", value: "hello v1.0" },
                filename: "",
                mediaType: "text/plain",
              },
            ],
            taskId: "",
            contextId: `probe-ctx-${Date.now()}`,
            extensions: [],
            metadata: {},
            referenceTaskIds: [],
          },
          configuration: undefined,
          metadata: undefined,
          tenant: "",
        },
      }),
    });
    assert.equal(direct.status, 200, "v1.0 SendMessage must be accepted");
    const json = (await direct.json()) as any;
    assert.ok(json.result, `v1.0 response must have a result, got: ${JSON.stringify(json).slice(0, 300)}`);

    // Negative: v0.3 method name must be rejected.
    const legacy = await globalThis.fetch(`${harness.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-2",
        method: "message/send",
        params: { message: { parts: [{ text: "hi" }] } },
      }),
    });
    const legacyJson = (await legacy.json()) as any;
    assert.ok(legacyJson.error, "v0.3 method name must be rejected by a v1.0 server");
    // Accept either method-not-found (-32601) or version-not-supported
    // (-32009) — both signal that the v0.3 request was correctly
    // rejected. On a v1.0-only server without legacyCompat, the
    // version check happens first and returns -32009; on a server
    // with legacyCompat, the method check returns -32601.
    assert.ok(
      legacyJson.error.code === -32601 || legacyJson.error.code === -32009,
      `must surface as method-not-found or version-not-supported, got code ${legacyJson.error.code}`,
    );
  });

  it("v1.0 client can complete a full round-trip via ClientFactory", async () => {
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(harness.baseUrl);

    const result = await (client as any).sendMessage({
      message: {
        messageId: `msg-${Date.now()}`,
        role: 1 as Role,
        parts: [textPart("hello")],
        // No taskId — fresh task.
        contextId: `ctx-${Date.now()}`,
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
      tenant: "",
    });

    assert.ok(result, "v1.0 client must receive a result");
    // v1.0 has no `kind` discriminator; Task has .status, Message has .messageId.
    const task = result as Task;
    assert.ok(task.status, "echo executor should return a task (has .status)");
    assert.equal(task.status.state, 3, "task should be in TASK_STATE_COMPLETED state");

    const replyArtifact = task.artifacts?.find((a) =>
      a.parts.some((p) => p.content?.$case === "text" && p.content.value.startsWith("echo: ")),
    );
    assert.ok(replyArtifact, "task should contain a reply artifact");
    const replyPart = replyArtifact!.parts.find(
      (p) => p.content?.$case === "text" && p.content.value.startsWith("echo: "),
    ) as Part;
    assert.equal(replyPart.content?.$case, "text");
    if (replyPart.content?.$case === "text") {
      assert.equal(replyPart.content.value, "echo: hello");
    }
  });
});