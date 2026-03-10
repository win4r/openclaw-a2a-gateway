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

import plugin from "../index.js";
import type { GatewayConfig } from "../src/types.js";

interface Service {
  id: string;
  start: (...args: any[]) => Promise<void> | void;
  stop: (...args: any[]) => Promise<void> | void;
}

/**
 * Mock WebSocket that returns a response with mediaUrl.
 */
function createMediaMockWebSocketClass() {
  return class MockGatewaySocket {
    readyState = 0;
    private readonly listeners = new Map<string, Set<(event: any) => void>>();

    constructor(_url: string) {
      this.listeners.set("open", new Set());
      this.listeners.set("message", new Set());
      this.listeners.set("error", new Set());
      this.listeners.set("close", new Set());
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "test-nonce" },
            }),
          });
        });
      });
    }

    send(data: string): void {
      const frame = JSON.parse(data) as { id: string; method: string; params?: any };
      if (frame.method === "connect") {
        this.respond(frame.id, true, { status: "ok" });
        return;
      }
      if (frame.method === "agent") {
        // Simulate accepted + final response with media
        this.respond(frame.id, true, { status: "accepted" });
        this.respond(frame.id, true, {
          status: "ok",
          result: {
            payloads: [
              {
                text: "Here is the generated image",
                mediaUrl: "https://cdn.example.com/generated-chart.png",
                mediaUrls: ["https://cdn.example.com/generated-chart.png"],
              },
            ],
          },
        });
        return;
      }
      this.respond(frame.id, false, null, { message: `unsupported: ${frame.method}` });
    }

    close(): void {
      this.readyState = 3;
      this.emit("close", {});
    }

    addEventListener(type: string, listener: (event: any) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }

    removeEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    private respond(id: string, ok: boolean, payload?: unknown, error?: unknown): void {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ type: "res", id, ok, payload, error }),
        });
      });
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  };
}

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
    let service: Service | null = null;

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMediaMockWebSocketClass();

    try {
      // Register plugin and capture the service
      plugin.register({
        pluginConfig: makeIntegrationConfig(port),
        config: { gateway: { port: 18789 } } as any,
        runtime: {} as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        on: () => {},
        registerGatewayMethod: () => {},
        registerService(svc: any) { service = svc; },
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        registerChannel: () => {},
        registerCli: () => {},
        registerProvider: () => {},
        registerCommand: () => {},
        resolvePath: (p: string) => p,
        id: "a2a-gateway",
        name: "A2A Gateway",
        source: "test",
      } as any);

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
            role: "user",
            parts: [
              { kind: "text", text: "Analyze this image" },
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
    let service: Service | null = null;

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMediaMockWebSocketClass();

    try {
      plugin.register({
        pluginConfig: makeIntegrationConfig(port),
        config: { gateway: { port: 18789 } } as any,
        runtime: {} as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        on: () => {},
        registerGatewayMethod: () => {},
        registerService(svc: any) { service = svc; },
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        registerChannel: () => {},
        registerCli: () => {},
        registerProvider: () => {},
        registerCommand: () => {},
        resolvePath: (p: string) => p,
        id: "a2a-gateway",
        name: "A2A Gateway",
        source: "test",
      } as any);

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
            role: "user",
            parts: [
              { kind: "text", text: "Read this" },
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
    let service: Service | null = null;

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMediaMockWebSocketClass();

    try {
      plugin.register({
        pluginConfig: makeIntegrationConfig(port),
        config: { gateway: { port: 18789 } } as any,
        runtime: {} as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        on: () => {},
        registerGatewayMethod: () => {},
        registerService(svc: any) { service = svc; },
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        registerChannel: () => {},
        registerCli: () => {},
        registerProvider: () => {},
        registerCommand: () => {},
        resolvePath: (p: string) => p,
        id: "a2a-gateway",
        name: "A2A Gateway",
        source: "test",
      } as any);

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
            role: "user",
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
    let service: Service | null = null;

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMediaMockWebSocketClass();

    // Override config with very small inline limit for testing
    const testConfig = makeIntegrationConfig(port);
    (testConfig.security as any).maxInlineFileSizeBytes = 100;  // flat field read by parseConfig

    try {
      plugin.register({
        pluginConfig: testConfig,
        config: { gateway: { port: 18789 } } as any,
        runtime: {} as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        on: () => {},
        registerGatewayMethod: () => {},
        registerService(svc: any) { service = svc; },
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        registerChannel: () => {},
        registerCli: () => {},
        registerProvider: () => {},
        registerCommand: () => {},
        resolvePath: (p: string) => p,
        id: "a2a-gateway",
        name: "A2A Gateway",
        source: "test",
      } as any);

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
            role: "user",
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
