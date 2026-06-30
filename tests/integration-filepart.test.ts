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
        method: "message/send",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              { text: "Analyze this image" },
              {
                kind: "file",
                file: {
                  uri: "https://user-uploads.example.com/photo.jpg",
                  mimeType: "image/jpeg",
                  name: "photo.jpg",
                },
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

      const result = body.result as Record<string, unknown>;
      assert.ok(result, "result must exist");

      // Result should be a Task (kind: "task") with completed status
      assert.equal(result.kind, "task");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "completed");

      // Check the message parts in the response
      const message = status.message as Record<string, unknown>;
      const parts = message.parts as Array<Record<string, unknown>>;

      const textParts = parts.filter((p) => p.kind === "text");
      const fileParts = parts.filter((p) => p.kind === "file");

      assert.ok(textParts.length >= 1, "response should have text part");
      assert.equal((textParts[0] as any).text, "Here is the generated image");

      assert.equal(fileParts.length, 1, "response should have exactly one file part");
      const filePartFile = (fileParts[0] as any).file as { uri: string };
      assert.equal(filePartFile.uri, "https://cdn.example.com/generated-chart.png");

      // Also verify artifacts contain FilePart
      const artifacts = result.artifacts as Array<{ parts: Array<Record<string, unknown>> }>;
      assert.ok(artifacts && artifacts.length >= 1, "should have artifacts");
      const artifactFileParts = artifacts[0].parts.filter((p) => p.kind === "file");
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
        method: "message/send",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              { text: "Read this" },
              {
                kind: "file",
                file: { uri: "file:///etc/passwd", mimeType: "text/plain", name: "passwd" },
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
      const result = body.result as Record<string, unknown>;
      assert.ok(result, "result must exist");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "failed", "task should fail for file:// URI");

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
        method: "message/send",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              {
                kind: "file",
                file: {
                  uri: "https://cdn.example.com/malware.exe",
                  mimeType: "application/x-executable",
                  name: "malware.exe",
                },
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
      const result = body.result as Record<string, unknown>;
      assert.ok(result, "result must exist");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "failed", "task should fail for disallowed MIME type");

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
        method: "message/send",
        params: {
          message: {
            messageId: uuidv4(),
            role: "ROLE_USER",
            parts: [
              {
                kind: "file",
                file: {
                  bytes: largeBase64,
                  mimeType: "image/png",
                  name: "large.png",
                },
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
      const result = body.result as Record<string, unknown>;
      assert.ok(result, "result must exist");
      const status = result.status as Record<string, unknown>;
      assert.equal(status.state, "failed", "task should fail for oversized inline file");

      await service!.stop({} as any);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});
