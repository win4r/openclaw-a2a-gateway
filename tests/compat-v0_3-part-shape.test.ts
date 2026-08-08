/**
 * A2A server-side legacyCompat translation harness.
 *
 * Purpose: prove that the v1.0 SDK's `jsonRpcHandler` with
 * `legacyCompat: { enabled: true }` correctly translates v0.3 and
 * v1.0 envelopes between wire and executor for a server that
 * speaks v1.0 internally.
 *
 * Pass criteria (the server-side compat contract):
 *   1. A v1.0 client sending `SendMessage` with v1.0 Part shape
 *      — executor sees v1.0 Part shape (no translation needed
 *      inbound; same shape on both sides).
 *   2. A v0.3 client sending `message/send` with v0.3 Part shape
 *      — SDK translates inbound Parts to v1.0 before executor sees
 *      them (without this, the executor would barf on `kind` vs
 *      `content.$case`).
 *   3. The executor's reply (always v1.0 Part shape internally)
 *      round-trips back to a v1.0 client correctly.
 *   4. The executor's v1.0 reply is translated back to v0.3 Part
 *      shape by the SDK on the way out to a v0.3 client.
 *
 * KEY FINDING driving this harness design:
 *   The SDK's `legacyCompat` translates inbound v0.3 Parts to v1.0
 *   Parts before the executor sees them (via LegacyJsonRpcTransportHandler
 *   → toCorePart). But the SDK does NOT translate executor reply Parts
 *   from v0.3 to v1.0. The executor must emit v1.0 Parts going forward;
 *   the SDK translates v1.0 → v0.3 on the way out to v0.3 clients.
 *
 *   This means the executor lives in v1.0 Part shape internally,
 *   even for dual-stack servers. A v0.3-only executor will silently
 *   fail on the reply path with "Invalid v1.0 part: missing content"
 *   when a v0.3 client receives the response.
 *
 * Why this exists (pre-port):
 *   Phronesis verified by reading SDK source that the inbound
 *   translation should work, but had not exercised it end-to-end.
 *   Doxa's Phase 1 ports the executor's caller (`jsonRpcHandler` with
 *   legacyCompat). The first live round-trip will fail if the
 *   executor's Part shape is wrong. This test catches that before
 *   the PR.
 *
 * Harness card shape: mirrors what Doxa's Phase 1 card will look
 * like — both a v0.3 entry and a v1.0 entry in `supportedInterfaces[]`.
 * Without the v0.3 entry, the SDK's `validateVersion` rejects a v0.3
 * request with VERSION_NOT_SUPPORTED regardless of the method name
 * on the wire.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { A2A_LEGACY_PROTOCOL_VERSION } from "@a2a-js/sdk/compat/v0_3";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";

import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentExecutor,
  type Artifact,
  type Part,
  type Task,
  type TaskState,
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
// Observed-Part capture — what the executor actually saw
// ---------------------------------------------------------------------------

interface ObservedRequest {
  rawRequestBody: unknown;
  executorParts: unknown[];
  executorPartShape: "v0.3" | "v1.0" | "unknown";
  methodName: string | null;
  a2aVersionHeader: string | null;
}

const OBSERVED: ObservedRequest[] = [];

// Per-request body capture. The SDK's middleware runs synchronously
// on the request and stashes the body here; the executor (which runs
// asynchronously inside the request handler) looks it up by id.
interface BodyCapture {
  body: unknown;
  method: string | null;
  a2aVersion: string | null;
}
const BODY_CAPTURES = new Map<string, BodyCapture>();
let CAPTURE_COUNTER = 0;

// ---------------------------------------------------------------------------
// Test fixture: an EchoExecutor that lives in v1.0 Part shape internally
// ---------------------------------------------------------------------------

function detectPartShape(parts: unknown[]): "v0.3" | "v1.0" | "unknown" {
  if (!Array.isArray(parts) || parts.length === 0) return "unknown";
  const first = parts[0] as Record<string, unknown>;
  if (typeof first.kind === "string" && "text" in first) return "v0.3";
  if (
    typeof first.content === "object" &&
    first.content !== null &&
    typeof (first.content as Record<string, unknown>).$case === "string"
  ) {
    return "v1.0";
  }
  return "unknown";
}

function extractV10Text(parts: unknown[]): string {
  for (const p of parts) {
    const part = p as Record<string, unknown>;
    if (part.content && typeof part.content === "object") {
      const content = part.content as Record<string, unknown>;
      if (content.$case === "text" && typeof content.value === "string") {
        return content.value;
      }
    }
  }
  return "(no v1.0 text part)";
}

class V10EchoExecutor implements AgentExecutor {
  cancelTask = async (_taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    /* no-op */
  };

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const parts = userMessage.parts ?? [];

    // The SDK doesn't currently surface a request id to the executor
    // directly, so we use the first non-observed capture as the
    // "current" one. This works because tests reset OBSERVED and
    // process one request at a time per test case.
    let lastCapture: BodyCapture | undefined;
    for (const cap of BODY_CAPTURES.values()) {
      lastCapture = cap; // Map preserves insertion order; take the most recent
    }

    OBSERVED.push({
      rawRequestBody: lastCapture?.body ?? null,
      executorParts: parts,
      executorPartShape: detectPartShape(parts),
      methodName: lastCapture?.method ?? null,
      a2aVersionHeader: lastCapture?.a2aVersion ?? null,
    });

    const inputText = extractV10Text(parts);

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
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: 2 as TaskState, // TASK_STATE_WORKING
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: undefined,
      }),
    );

    // 3. Reply artifact — v1.0 Part shape. The SDK's outbound
    // transport translates this to v0.3 Part shape when sending
    // back to a v0.3 client, and emits it as-is to a v1.0 client.
    const resultArtifact: Artifact = {
      artifactId: uuidv4(),
      name: "Result",
      description: "Echo reply (v1.0 Part shape internally)",
      parts: [
        {
          content: { $case: "text", value: `v10-echo: ${inputText}` },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
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
// Card builder
// ---------------------------------------------------------------------------

// Build a dual-stack card pointing at the actual bound port. The v1.0
// SDK's outbound transport reads the URL directly from supportedInterfaces[].
// IMPORTANT: the URL must match the Express path the jsonRpcHandler is
// mounted at. The SDK's handler internally registers POST "/" — so if
// you mount it via `app.use("/a2a/jsonrpc", jsonRpcHandler(...))`, the
// effective endpoint is POST /a2a/jsonrpc and the card URL must include
// that path. Mismatch → 404 on outbound.
function buildFixtureCard(baseUrl: string): AgentCard {
  return {
    name: "compat-harness",
    description: "Server-side compat harness for v0.3 Part-shape translation",
    version: "1.0.0",
    provider: {
      organization: "psifunctiondev",
      url: baseUrl,
    },
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION, // "1.0"
      },
      {
        url: `${baseUrl}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_LEGACY_PROTOCOL_VERSION, // "0.3"
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
        description: "Echoes back the user's text",
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
}

// ---------------------------------------------------------------------------
// Harness boot
// ---------------------------------------------------------------------------

interface Harness {
  port: number;
  baseUrl: string;
  cardUrl: string;
  server: import("node:http").Server;
}

async function bootHarness(): Promise<Harness> {
  const executor = new V10EchoExecutor();

  // First, bind to an ephemeral port to learn which one we got.
  const probe = express();
  const probeServer = probe.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => probeServer.on("listening", () => resolve()));
  const port = (probeServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));

  // Now rebuild the express app with the real handlers, using the
  // known port so the card URL is correct.
  const card = buildFixtureCard(baseUrl);
  const taskStore: TaskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);

  const app: Express = express();
  app.use(express.json());

  // Capture raw body, method name, A2A-Version header on every
  // incoming request. Keyed by an incrementing counter; the executor
  // picks up the most recent capture.
  app.use((req, _res, next) => {
    const captureId = `${++CAPTURE_COUNTER}`;
    const body = req.body && typeof req.body === "object" ? req.body : null;
    BODY_CAPTURES.set(captureId, {
      body,
      method: body && typeof (body as { method?: string }).method === "string"
        ? (body as { method: string }).method
        : null,
      a2aVersion: typeof req.headers["a2a-version"] === "string"
        ? (req.headers["a2a-version"] as string)
        : null,
    });
    // Stash the captureId on the request so the executor (if it had
    // access to req) could read it directly. Since the executor doesn't,
    // we rely on the "most recent capture" heuristic.
    (req as { captureId?: string }).captureId = captureId;
    next();
  });

  // Mount the card on both v1.0 (canonical) and v0.3 (legacy) paths.
  // NOTE: AGENT_CARD_PATH from the SDK is ".well-known/agent-card.json"
  // (relative). Express's app.use() needs an absolute path.
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

  // KEY: legacyCompat enabled. Routes v0.3 method names (message/send)
  // to a legacy handler that translates inbound Parts v0.3 → v1.0.
  // Mounted at /a2a/jsonrpc to match the card's supportedInterfaces[].url
  // AND to mirror how Doxa's existing card uses /a2a/jsonrpc.
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2A server-side legacyCompat Part-shape translation", () => {
  let harness: Harness;

  before(async () => {
    harness = await bootHarness();
  });

  after(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    BODY_CAPTURES.clear();
    OBSERVED.length = 0;
  });

  it("v1.0 client sending SendMessage with v1.0 Part shape — executor sees v1.0 Part shape", async () => {
    OBSERVED.length = 0;
    BODY_CAPTURES.clear();

    const factory = new ClientFactory();
    const client = await factory.createFromUrl(harness.baseUrl);

    const inputText = "hello from v1.0 client";
    const result = await (client as any).sendMessage({
      message: {
        messageId: `v10-${Date.now()}`,
        role: 1, // ROLE_USER
        parts: [
          {
            content: { $case: "text", value: inputText },
            filename: "",
            mediaType: "text/plain",
          },
        ],
        // No taskId — this is a new task, not a follow-up.
        contextId: `v10-ctx-${Date.now()}`,
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
      tenant: "",
    });

    assert.ok(result, "v1.0 client must receive a result");

    const obs = OBSERVED[OBSERVED.length - 1];
    assert.ok(obs, "executor must have been invoked");

    // The executor receives the v1.0 Part shape as-is (no translation
    // needed; same shape on both sides).
    assert.equal(
      obs.executorPartShape,
      "v1.0",
      `executor must see v1.0 Part shape for v1.0 inbound, got ${obs.executorPartShape}. ` +
        `Raw observed parts: ${JSON.stringify(obs.executorParts, null, 2)}`,
    );
    assert.equal(obs.methodName, "SendMessage", "wire method name should be SendMessage");
  });

  it("v0.3 client sending message/send with v0.3 Part shape — SDK translates inbound Parts to v1.0", async () => {
    OBSERVED.length = 0;
    BODY_CAPTURES.clear();

    const direct = await globalThis.fetch(`${harness.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "v03-probe",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "v03-msg-1",
            role: "user",
            parts: [{ kind: "text", text: "hello from v0.3 client" }],
            contextId: "v03-ctx",
          },
        },
      }),
    });
    assert.equal(direct.status, 200, "v0.3 message/send must be accepted");
    const json = (await direct.json()) as any;
    assert.ok(json.result, `v0.3 reply must have a result, got: ${JSON.stringify(json).slice(0, 300)}`);

    const obs = OBSERVED[OBSERVED.length - 1];
    assert.ok(obs, "executor must have been invoked for v0.3 request");

    // SDK translated the v0.3 Part to v1.0 before the executor saw it.
    assert.equal(
      obs.executorPartShape,
      "v1.0",
      `executor must see v1.0 Part shape (translated from v0.3), got ${obs.executorPartShape}. ` +
        `Raw observed parts: ${JSON.stringify(obs.executorParts, null, 2)}`,
    );
    assert.equal(obs.methodName, "message/send", "wire method name should be message/send");

    const v10Part = obs.executorParts[0] as { content?: { $case?: string; value?: string } };
    assert.equal(v10Part.content?.$case, "text");
    assert.equal(v10Part.content?.value, "hello from v0.3 client", "executor must see the original v0.3 text content");
  });

  it("v0.3 executor reply translated to v0.3 Part shape for v0.3 client", async () => {
    OBSERVED.length = 0;
    BODY_CAPTURES.clear();

    // v0.3 client request. Executor emits v1.0 Part in reply; SDK
    // translates to v0.3 Part on the way out.
    const direct = await globalThis.fetch(`${harness.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "v03-out",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "v03-out-msg",
            role: "user",
            parts: [{ kind: "text", text: "outbound translation test" }],
            contextId: "v03-out-ctx",
          },
        },
      }),
    });
    assert.equal(direct.status, 200, "v0.3 message/send must be accepted");
    const json = (await direct.json()) as any;
    assert.ok(json.result, `v0.3 reply must have a result, got: ${JSON.stringify(json).slice(0, 300)}`);

    // The v0.3 reply should have the artifact in v0.3 shape.
    const result = json.result;
    const artifacts = result?.artifacts ?? [];
    assert.ok(
      artifacts.length > 0,
      `v0.3 reply must include an artifact, got: ${JSON.stringify(result, null, 2).slice(0, 500)}`,
    );

    const replyPart = artifacts[0].parts.find(
      (p: any) => p.kind === "text" && typeof p.text === "string",
    );
    assert.ok(
      replyPart,
      `v0.3 reply Part must be v0.3-shaped ({kind: "text", text}), got: ${JSON.stringify(artifacts[0].parts, null, 2)}`,
    );
    assert.equal(replyPart.text, "v10-echo: outbound translation test");
  });

  it("v1.0 executor reply round-trips to v1.0 client as v1.0 Part shape", async () => {
    OBSERVED.length = 0;
    BODY_CAPTURES.clear();

    const factory = new ClientFactory();
    const client = await factory.createFromUrl(harness.baseUrl);

    const result = await (client as any).sendMessage({
      message: {
        messageId: `rt-${Date.now()}`,
        role: 1,
        parts: [
          {
            content: { $case: "text", value: "round-trip test" },
            filename: "",
            mediaType: "text/plain",
          },
        ],
        // No taskId — fresh task.
        contextId: `rt-ctx-${Date.now()}`,
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
      tenant: "",
    });

    assert.ok(result, "v1.0 client must receive a result");
    // v1.0 doesn't have a `kind` discriminator on Task/Message. Tell
    // them apart by presence of `status` (Task) vs `messageId` (Message).
    const task = result as Task;
    assert.ok(task.status, "echo executor should return a task (has .status)");
    assert.equal(task.status.state, 3, "task should be in TASK_STATE_COMPLETED state");

    const replyArtifact = task.artifacts?.find((a) =>
      a.parts.some((p) => p.content?.$case === "text" && p.content.value.startsWith("v10-echo: ")),
    );
    assert.ok(
      replyArtifact,
      "v1.0 client must receive the executor's reply in v1.0 Part shape. " +
        `Got artifacts: ${JSON.stringify(task.artifacts, null, 2)}`,
    );

    const replyPart = replyArtifact!.parts.find(
      (p) => p.content?.$case === "text",
    ) as Part;
    if (replyPart.content?.$case === "text") {
      assert.equal(replyPart.content.value, "v10-echo: round-trip test");
    }
  });
});