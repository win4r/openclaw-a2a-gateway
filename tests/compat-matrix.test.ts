/**
 * Cross-implementation compatibility test matrix.
 *
 * Validates that the gateway can handle Agent Card formats, inbound message
 * structures, and response patterns produced by different A2A implementations
 * (Google reference server, @a2a-js/sdk, other community servers).
 *
 * These tests do NOT require live peers — they mock fetch/WebSocket to
 * simulate the various payload shapes that real implementations produce.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentCard } from "../src/agent-card.js";
import { OpenClawAgentExecutor } from "../src/executor.js";
import type { GatewayConfig } from "../src/types.js";

import {
  createApi,
  createHarness,
  createMockWebSocketClass,
  invokeGatewayMethod,
  makeConfig,
  registerPlugin,
  silentLogger,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// 1. Agent Card variations
// ---------------------------------------------------------------------------

describe("compat: Agent Card parsing variations", () => {
  it("client parses minimal Agent Card (protocolVersion + name + url + skills)", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Minimal Agent",
            url: "http://mock-minimal/a2a/jsonrpc",
            skills: [{ id: "s1", name: "echo", description: "Echo skill", tags: [] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-minimal/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        received.push(body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "minimal-peer", agentCardUrl: "http://mock-minimal/.well-known/agent-card.json" }],
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "minimal-peer",
        message: { text: "hello minimal" },
      });

      assert.equal(result.ok, true, "should succeed with minimal Agent Card");
      assert.equal(received.length, 1, "should have sent one request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("client handles Agent Card with extra unknown fields (forward compat)", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Extended Agent",
            url: "http://mock-extended/a2a/jsonrpc",
            skills: [{ id: "s1", name: "chat", description: "Chat", tags: ["general"] }],
            // Extra fields that future versions of the spec may add
            futureField: "should be ignored",
            customExtension: { nested: true, value: 42 },
            vendor: { name: "TestCorp", version: "2.0" },
            capabilities: {
              streaming: true,
              pushNotifications: true,
              stateTransitionHistory: true,
              customCapability: "new-thing",
            },
            securitySchemes: {
              bearer: { type: "http", scheme: "bearer" },
            },
            security: [{ bearer: [] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-extended/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        received.push(body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "extended-peer", agentCardUrl: "http://mock-extended/.well-known/agent-card.json" }],
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "extended-peer",
        message: { text: "hello extended" },
      });

      assert.equal(result.ok, true, "should succeed despite unknown fields in Agent Card");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("client handles skills with various formats (with/without tags, with/without id)", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Multi-Skill Agent",
            url: "http://mock-skills/a2a/jsonrpc",
            skills: [
              { id: "sk-1", name: "code-review", description: "Review code", tags: ["dev", "review"] },
              { name: "translate", description: "Translate text" },
              { id: "sk-3", name: "summarize", description: "Summarize content", tags: [] },
              { id: "sk-4", name: "bare-minimum" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-skills/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        received.push(body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "skills-peer", agentCardUrl: "http://mock-skills/.well-known/agent-card.json" }],
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "skills-peer",
        message: { text: "test skills formats" },
      });

      assert.equal(result.ok, true, "should handle diverse skill formats");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("client handles Agent Card with no optional fields (no securitySchemes, no additionalInterfaces)", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        // A bare-bones card that only has required fields.
        // Some lightweight implementations may omit everything else.
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Bare Agent",
            url: "http://mock-bare/a2a/jsonrpc",
            skills: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-bare/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        received.push(body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "bare-peer", agentCardUrl: "http://mock-bare/.well-known/agent-card.json" }],
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "bare-peer",
        message: { text: "hello bare" },
      });

      assert.equal(result.ok, true, "should succeed with bare-minimum Agent Card");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("client handles different protocolVersion strings (0.3.0, 0.3.1)", async () => {
    for (const version of ["0.3.0", "0.3.1"]) {
      const received: Array<Record<string, unknown>> = [];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
          return new Response(
            JSON.stringify({
              protocolVersion: version,
              name: `Agent v${version}`,
              url: "http://mock-version/a2a/jsonrpc",
              skills: [{ id: "s1", name: "chat", description: "Chat", tags: [] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url === "http://mock-version/a2a/jsonrpc") {
          const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
          received.push(body);
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      try {
        const harness = createHarness(
          makeConfig({
            peers: [{ name: "version-peer", agentCardUrl: "http://mock-version/.well-known/agent-card.json" }],
          }),
        );

        const result = await invokeGatewayMethod(harness, "a2a.send", {
          peer: "version-peer",
          message: { text: `testing version ${version}` },
        });

        assert.equal(result.ok, true, `should succeed with protocolVersion ${version}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it("buildAgentCard produces valid card regardless of config completeness", () => {
    // Empty config — all defaults
    const defaultCard = buildAgentCard({} as unknown as GatewayConfig) as Record<string, unknown>;
    assert.equal(defaultCard.protocolVersion, "0.3.0");
    assert.ok(defaultCard.name, "should have a name");
    assert.ok(defaultCard.url, "should have a url");
    assert.ok(Array.isArray(defaultCard.skills), "should have skills array");

    // Partial config — only name provided
    const partialCard = buildAgentCard(
      makeConfig({ agentCard: { name: "PartialBot" } }) as unknown as GatewayConfig,
    ) as Record<string, unknown>;
    assert.equal(partialCard.name, "PartialBot");
    assert.equal(partialCard.protocolVersion, "0.3.0");

    // Full config
    const fullCard = buildAgentCard(
      makeConfig({
        agentCard: {
          name: "FullBot",
          description: "A fully configured bot",
          url: "https://full.example.com/a2a/jsonrpc",
          skills: [
            { id: "s1", name: "chat", description: "Chat skill" },
            "simple-skill",
          ],
        },
      }) as unknown as GatewayConfig,
    ) as Record<string, unknown>;
    assert.equal(fullCard.name, "FullBot");
    const fullSkills = fullCard.skills as Array<Record<string, unknown>>;
    assert.equal(fullSkills.length, 2);
    assert.equal(fullSkills[0].name, "chat");
    assert.equal(fullSkills[1].name, "simple-skill");
  });
});

// ---------------------------------------------------------------------------
// 2. Message format variations (inbound)
// ---------------------------------------------------------------------------

describe("compat: inbound message format variations", () => {
  it("handles message with only TextPart (standard case)", async () => {
    const api = createApi();
    let capturedMessage = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => { capturedMessage = params.message as string; },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);

      await executor.execute(
        {
          taskId: "task-text-only",
          contextId: "ctx-text-only",
          userMessage: {
            messageId: "msg-text-only",
            role: "user",
            parts: [{ kind: "text", text: "simple text message" }],
          },
        } as any,
        { publish() {}, finished() {} } as any,
      );

      assert.ok(capturedMessage.includes("simple text message"), "should forward text content");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("handles message with mixed TextPart + FilePart + DataPart", async () => {
    const api = createApi();
    let capturedMessage = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => { capturedMessage = params.message as string; },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);

      await executor.execute(
        {
          taskId: "task-mixed",
          contextId: "ctx-mixed",
          userMessage: {
            messageId: "msg-mixed",
            role: "user",
            parts: [
              { kind: "text", text: "Check this data and file" },
              {
                kind: "file",
                file: {
                  uri: "https://example.com/report.pdf",
                  mimeType: "application/pdf",
                  name: "report.pdf",
                },
              },
              {
                kind: "data",
                mimeType: "application/json",
                data: { status: "ready", count: 5 },
              },
            ],
          },
        } as any,
        { publish() {}, finished() {} } as any,
      );

      assert.ok(capturedMessage.includes("Check this data and file"), "should include text");
      assert.ok(capturedMessage.includes("report.pdf"), "should include file info");
      assert.ok(capturedMessage.includes("application/pdf"), "should include mime type");
      assert.ok(capturedMessage.includes("ready"), "should include data content");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("handles message with empty parts array gracefully", async () => {
    const api = createApi();
    let capturedMessage = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => { capturedMessage = params.message as string; },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];
      let finishedCalled = false;

      await executor.execute(
        {
          taskId: "task-empty-parts",
          contextId: "ctx-empty-parts",
          userMessage: {
            messageId: "msg-empty-parts",
            role: "user",
            parts: [],
          },
        } as any,
        {
          publish(event: unknown) { published.push(event); },
          finished() { finishedCalled = true; },
        } as any,
      );

      // Should still complete without crashing — empty parts result in fallback
      assert.equal(finishedCalled, true, "should call finished");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("handles parts with extra unknown fields (forward compat)", async () => {
    const api = createApi();
    let capturedMessage = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => { capturedMessage = params.message as string; },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);

      await executor.execute(
        {
          taskId: "task-extra-fields",
          contextId: "ctx-extra-fields",
          userMessage: {
            messageId: "msg-extra-fields",
            role: "user",
            parts: [
              {
                kind: "text",
                text: "forward compat test",
                // Unknown fields that future spec versions may add
                metadata: { source: "test-harness" },
                annotations: [{ type: "highlight", range: [0, 5] }],
              },
            ],
          },
        } as any,
        { publish() {}, finished() {} } as any,
      );

      assert.ok(capturedMessage.includes("forward compat test"), "should extract text despite extra fields");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("handles message with missing role field (should default gracefully)", async () => {
    const api = createApi();
    let capturedMessage = "";

    const MockWS = createMockWebSocketClass({
      onAgent: (params) => { capturedMessage = params.message as string; },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];
      let finishedCalled = false;

      await executor.execute(
        {
          taskId: "task-no-role",
          contextId: "ctx-no-role",
          userMessage: {
            messageId: "msg-no-role",
            // Deliberately omit `role`
            parts: [{ kind: "text", text: "no role specified" }],
          },
        } as any,
        {
          publish(event: unknown) { published.push(event); },
          finished() { finishedCalled = true; },
        } as any,
      );

      // Should not crash — the executor should handle missing role
      assert.equal(finishedCalled, true, "should call finished even without role");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Response format variations (outbound from different server styles)
// ---------------------------------------------------------------------------

describe("compat: response format variations", () => {
  it("handles standard JSON-RPC response with result (from a2a.send)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Standard Server",
            url: "http://mock-standard/a2a/jsonrpc",
            skills: [{ id: "s1", name: "chat", description: "Chat", tags: [] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-standard/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        // Standard JSON-RPC response with result.task
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              kind: "task",
              id: "task-123",
              contextId: "ctx-123",
              status: { state: "completed", message: { role: "agent", parts: [{ kind: "text", text: "Done" }] } },
              artifacts: [{ parts: [{ kind: "text", text: "Result artifact" }] }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "standard-peer", agentCardUrl: "http://mock-standard/.well-known/agent-card.json" }],
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "standard-peer",
        message: { text: "ping" },
      });

      assert.equal(result.ok, true, "should handle standard JSON-RPC result");
      const data = result.data as Record<string, unknown>;
      assert.ok(data.response, "should have response payload");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles JSON-RPC error response with standard code -32600", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Error Server",
            url: "http://mock-error/a2a/jsonrpc",
            skills: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-error/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        // JSON-RPC spec: error responses use HTTP 200 with error in body
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32600, message: "Invalid Request" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "error-peer", agentCardUrl: "http://mock-error/.well-known/agent-card.json" }],
          resilience: { retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } },
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "error-peer",
        message: { text: "trigger error" },
      });

      // The SDK may throw or return an error — either way we should not crash
      assert.equal(typeof result.ok, "boolean", "should return a boolean ok status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles JSON-RPC error with custom error code (non-standard implementations)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Custom Error Server",
            url: "http://mock-custom-err/a2a/jsonrpc",
            skills: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-custom-err/a2a/jsonrpc") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        // Return HTTP 200 with JSON-RPC error (some implementations use custom codes)
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -50000,
              message: "Custom vendor error: rate limited",
              data: { retryAfter: 30 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [{ name: "custom-err-peer", agentCardUrl: "http://mock-custom-err/.well-known/agent-card.json" }],
          resilience: { retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } },
        }),
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "custom-err-peer",
        message: { text: "trigger custom error" },
      });

      assert.equal(typeof result.ok, "boolean", "should return a boolean ok status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executor handles agent response with single TextPart correctly", async () => {
    const api = createApi();

    const MockWS = createMockWebSocketClass({
      agentResponsePayloads: [{ kind: "text", text: "Standard text reply" }],
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];

      await executor.execute(
        {
          taskId: "task-std-resp",
          contextId: "ctx-std-resp",
          userMessage: {
            messageId: "msg-std-resp",
            role: "user",
            parts: [{ kind: "text", text: "reply test" }],
          },
        } as any,
        {
          publish(event: unknown) { published.push(event); },
          finished() {},
        } as any,
      );

      const finalTask = published[published.length - 1] as Record<string, unknown>;
      const status = finalTask.status as Record<string, unknown>;
      assert.equal(status.state, "completed");

      const msg = status.message as Record<string, unknown>;
      const parts = msg.parts as Array<Record<string, unknown>>;
      assert.ok(parts.length >= 1, "should have at least one part");
      assert.equal(parts[0].kind, "text");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("executor handles response with text + mediaUrls (mixed content)", async () => {
    const api = createApi();

    const MockWS = createMockWebSocketClass({
      agentResponsePayloads: [
        {
          text: "Here are results",
          mediaUrl: "https://example.com/result.png",
          mediaUrls: ["https://example.com/result.png", "https://example.com/chart.svg"],
        },
      ],
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(api, makeConfig() as unknown as GatewayConfig);
      const published: unknown[] = [];

      await executor.execute(
        {
          taskId: "task-mixed-resp",
          contextId: "ctx-mixed-resp",
          userMessage: {
            messageId: "msg-mixed-resp",
            role: "user",
            parts: [{ kind: "text", text: "generate mixed content" }],
          },
        } as any,
        {
          publish(event: unknown) { published.push(event); },
          finished() {},
        } as any,
      );

      const finalTask = published[published.length - 1] as Record<string, unknown>;
      const status = finalTask.status as Record<string, unknown>;
      assert.equal(status.state, "completed");

      const msg = status.message as Record<string, unknown>;
      const parts = msg.parts as Array<Record<string, unknown>>;

      const textParts = parts.filter((p) => p.kind === "text");
      const fileParts = parts.filter((p) => p.kind === "file");
      assert.ok(textParts.length >= 1, "should have text part");
      assert.equal(fileParts.length, 2, "should have two file parts (deduped from mediaUrl + mediaUrls)");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Transport header variations
// ---------------------------------------------------------------------------

describe("compat: transport header variations", () => {
  it("bearer auth token is sent with correct 'Bearer ' prefix to peer", async () => {
    let capturedAuthHeader = "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        // Capture auth header on card fetch
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.authorization) {
          capturedAuthHeader = headers.authorization;
        }
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Auth Test Server",
            url: "http://mock-auth/a2a/jsonrpc",
            skills: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-auth/a2a/jsonrpc") {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.authorization) {
          capturedAuthHeader = headers.authorization;
        }
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [
            {
              name: "auth-peer",
              agentCardUrl: "http://mock-auth/.well-known/agent-card.json",
              auth: { type: "bearer", token: "test-token-abc123" },
            },
          ],
        }),
      );

      await invokeGatewayMethod(harness, "a2a.send", {
        peer: "auth-peer",
        message: { text: "auth test" },
      });

      assert.ok(
        capturedAuthHeader.startsWith("Bearer "),
        `auth header should start with "Bearer " but got "${capturedAuthHeader}"`,
      );
      assert.ok(
        capturedAuthHeader.includes("test-token-abc123"),
        "auth header should contain the token",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("apiKey auth is sent via x-api-key header", async () => {
    let capturedApiKeyHeader = "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/agent-card.json") || url.includes(".well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "ApiKey Test Server",
            url: "http://mock-apikey/a2a/jsonrpc",
            skills: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://mock-apikey/a2a/jsonrpc") {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.["x-api-key"]) {
          capturedApiKeyHeader = headers["x-api-key"];
        }
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [
            {
              name: "apikey-peer",
              agentCardUrl: "http://mock-apikey/.well-known/agent-card.json",
              auth: { type: "apiKey", token: "my-api-key-xyz" },
            },
          ],
        }),
      );

      await invokeGatewayMethod(harness, "a2a.send", {
        peer: "apikey-peer",
        message: { text: "apikey test" },
      });

      assert.equal(capturedApiKeyHeader, "my-api-key-xyz", "x-api-key header should contain the token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("inbound bearer auth works with correct 'Bearer ' prefix", async () => {
    // This tests the server-side (inbound) auth via the Express endpoint.
    // We spin up the actual HTTP server and send a request with auth.
    const port = 18950 + Math.floor(Math.random() * 50);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const config = {
        agentCard: {
          name: "Auth Inbound Test",
          url: `http://127.0.0.1:${port}/a2a/jsonrpc`,
          skills: [{ name: "chat" }],
        },
        server: { host: "127.0.0.1", port },
        peers: [],
        security: {
          inboundAuth: "bearer",
          token: "inbound-secret-token",
        },
        routing: { defaultAgentId: "test-agent" },
      };

      const { service } = registerPlugin(config);
      assert.ok(service, "service must be registered");
      await service!.start({} as any);
      await new Promise((r) => setTimeout(r, 500));

      // Request WITHOUT auth — should be rejected
      const noAuthResp = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "test-1",
          method: "message/send",
          params: {
            message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "no auth" }] },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });

      const noAuthBody = await noAuthResp.json() as Record<string, unknown>;
      assert.ok(noAuthBody.error, "should reject request without auth token");

      // Request WITH correct auth — should succeed
      const authResp = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-secret-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "test-2",
          method: "message/send",
          params: {
            message: { messageId: "m2", role: "user", parts: [{ kind: "text", text: "with auth" }] },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(authResp.status, 200, "should accept request with correct auth");
      const authBody = await authResp.json() as Record<string, unknown>;
      assert.ok(!authBody.error, "should not have error with correct auth");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("inbound bearer auth rejects token without 'Bearer ' prefix", async () => {
    const port = 18950 + Math.floor(Math.random() * 50);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const config = {
        agentCard: {
          name: "Auth Prefix Test",
          url: `http://127.0.0.1:${port}/a2a/jsonrpc`,
          skills: [{ name: "chat" }],
        },
        server: { host: "127.0.0.1", port },
        peers: [],
        security: {
          inboundAuth: "bearer",
          token: "prefix-test-token",
        },
        routing: { defaultAgentId: "test-agent" },
      };

      const { service } = registerPlugin(config);
      assert.ok(service, "service must be registered");
      await service!.start({} as any);
      await new Promise((r) => setTimeout(r, 500));

      // Send with raw token (no "Bearer " prefix) — some clients may do this
      const rawTokenResp = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "prefix-test-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "test-raw",
          method: "message/send",
          params: {
            message: { messageId: "m-raw", role: "user", parts: [{ kind: "text", text: "raw token" }] },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });

      const rawBody = await rawTokenResp.json() as Record<string, unknown>;
      // Per spec, Authorization header must use "Bearer <token>" format.
      // A raw token without the prefix should be rejected.
      assert.ok(rawBody.error, "should reject token without Bearer prefix");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});
