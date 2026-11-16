/**
 * Integration test: verifies that the A2A JSON-RPC endpoint correctly handles
 * FilePart in inbound messages and returns FilePart in outbound responses.
 *
 * This test spins up the actual Express server (without a real OpenClaw Gateway)
 * using a mock WebSocket to simulate the Gateway RPC.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { v4 as uuidv4 } from "uuid";

import {
  createMockWebSocketClass,
  registerPlugin,
} from "./helpers.js";

function makeIntegrationConfig(port: number) {
  return {
    agentCard: {
      name: "FilePart Test Agent",
      description: "Integration test for FilePart",
      url: `http://127.0.0.1:${port}/a2a/jsonrpc`,
      skills: [{ name: "file-transfer" }],
    },
    server: { host: "127.0.0.1", port },
    peers: [],
    security: {
      inboundAuth: "none",
    },
    routing: { defaultAgentId: "test-agent" },
  };
}

describe("integration: FilePart end-to-end", () => {
  it("sends message with FilePart via JSON-RPC and receives FilePart in response", async () => {
    const port = 18850 + Math.floor(Math.random() * 100);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass({
      agentResponsePayloads: [
        {
          text: "Here is the generated image",
          mediaUrl: "https://cdn.example.com/generated-chart.png",
          mediaUrls: ["https://cdn.example.com/generated-chart.png"],
        },
      ],
    });

    try {
      const { service } = registerPlugin(makeIntegrationConfig(port));

      assert.ok(service, "service must be registered");
      await service!.start({} as any);

      // Wait for server to be ready
      await new Promise((r) => setTimeout(r, 500));

      // Send A2A JSON-RPC request with FilePart in the message
      const jsonRpcRequest = {
        jsonrpc: "2.0",
        id: uuidv4(),
        method: "SendMessage",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              { text: "Analyze this image" },
              {
                url: "https://user-uploads.example.com/photo.jpg",
                mediaType: "image/jpeg",
                filename: "photo.jpg",
              },
            ],
          },
        },
      };

      const response = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonRpcRequest),
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(response.status, 200, `expected 200, got ${response.status}`);

      const body = await response.json() as Record<string, unknown>;

      // The response should be a JSON-RPC result (not error)
      assert.ok(!body.error, `unexpected error: ${JSON.stringify(body.error)}`);

      const result = ((body.result as any)?.task ?? body.result) as Record<string, unknown>;
      assert.ok(result, `result must exist: ${JSON.stringify(body)}`);

      // Result should be a Task (kind: "task") with completed status
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "TASK_STATE_COMPLETED");

      // Check the message parts in the response
      const message = status.message as Record<string, unknown>;
      const parts = message.parts as Array<Record<string, unknown>>;

      const textParts = parts.filter((p) => typeof p.text === "string");
      const fileParts = parts.filter((p) => typeof p.url === "string" || typeof p.raw === "string");

      assert.ok(textParts.length >= 1, "response should have text part");
      assert.equal((textParts[0] as any).text, "Here is the generated image");

      assert.equal(fileParts.length, 1, "response should have exactly one file part");
      assert.equal((fileParts[0] as any).url, "https://cdn.example.com/generated-chart.png");

      // Also verify artifacts contain FilePart
      const artifacts = result.artifacts as Array<{ parts: Array<Record<string, unknown>> }>;
      assert.ok(artifacts && artifacts.length >= 1, "should have artifacts");
      const artifactFileParts = artifacts[0].parts.filter((p) => typeof p.url === "string" || typeof p.raw === "string");
      assert.equal(artifactFileParts.length, 1, "artifact should contain file part");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("rejects inbound FilePart with file:// URI (SSRF)", async () => {
    const port = 18850 + Math.floor(Math.random() * 100);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass({
      agentResponsePayloads: [
        {
          text: "Here is the generated image",
          mediaUrl: "https://cdn.example.com/generated-chart.png",
          mediaUrls: ["https://cdn.example.com/generated-chart.png"],
        },
      ],
    });

    try {
      const { service } = registerPlugin(makeIntegrationConfig(port));

      assert.ok(service, "service must be registered");
      await service!.start({} as any);
      await new Promise((r) => setTimeout(r, 500));

      const jsonRpcRequest = {
        jsonrpc: "2.0",
        id: uuidv4(),
        method: "SendMessage",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              { text: "Read this" },
              {
                url: "file:///etc/passwd",
                mediaType: "text/plain",
                filename: "passwd",
              },
            ],
          },
        },
      };

      const response = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonRpcRequest),
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      const result = ((body.result as any)?.task ?? body.result) as Record<string, unknown>;
      assert.ok(result, "result must exist");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "TASK_STATE_FAILED", "task should fail for file:// URI");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("rejects inbound FilePart with disallowed MIME type", async () => {
    const port = 18850 + Math.floor(Math.random() * 100);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass({
      agentResponsePayloads: [
        {
          text: "Here is the generated image",
          mediaUrl: "https://cdn.example.com/generated-chart.png",
          mediaUrls: ["https://cdn.example.com/generated-chart.png"],
        },
      ],
    });

    try {
      const { service } = registerPlugin(makeIntegrationConfig(port));

      assert.ok(service, "service must be registered");
      await service!.start({} as any);
      await new Promise((r) => setTimeout(r, 500));

      const jsonRpcRequest = {
        jsonrpc: "2.0",
        id: uuidv4(),
        method: "SendMessage",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              {
                url: "https://cdn.example.com/malware.exe",
                mediaType: "application/x-executable",
                filename: "malware.exe",
              },
            ],
          },
        },
      };

      const response = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonRpcRequest),
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      const result = ((body.result as any)?.task ?? body.result) as Record<string, unknown>;
      assert.ok(result, "result must exist");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "TASK_STATE_FAILED", "task should fail for disallowed MIME type");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("rejects inbound inline FilePart exceeding size limit", async () => {
    const port = 18850 + Math.floor(Math.random() * 100);

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass({
      agentResponsePayloads: [
        {
          text: "Here is the generated image",
          mediaUrl: "https://cdn.example.com/generated-chart.png",
          mediaUrls: ["https://cdn.example.com/generated-chart.png"],
        },
      ],
    });

    // Override config with very small inline limit for testing
    const testConfig = makeIntegrationConfig(port);
    (testConfig.security as any).maxInlineFileSizeBytes = 100;  // flat field read by parseConfig

    try {
      const { service } = registerPlugin(testConfig);

      assert.ok(service, "service must be registered");
      await service!.start({} as any);
      await new Promise((r) => setTimeout(r, 500));

      // Create a base64 string that decodes to > 100 bytes
      const largeBase64 = Buffer.alloc(200).toString("base64");

      const jsonRpcRequest = {
        jsonrpc: "2.0",
        id: uuidv4(),
        method: "SendMessage",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              {
                raw: largeBase64,
                mediaType: "image/png",
                filename: "large.png",
              },
            ],
          },
        },
      };

      const response = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonRpcRequest),
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      const result = ((body.result as any)?.task ?? body.result) as Record<string, unknown>;
      assert.ok(result, `result must exist: ${JSON.stringify(body)}`);
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "TASK_STATE_FAILED", "task should fail for oversized inline file");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});
