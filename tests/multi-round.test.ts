import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";

import { OpenClawAgentExecutor } from "../src/executor.js";
import { FileTaskStore } from "../src/task-store.js";
import type { GatewayConfig } from "../src/types.js";

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentCard: {
      name: "Test Agent",
      description: "test card",
      url: "http://127.0.0.1:18800/a2a/jsonrpc",
      skills: [{ name: "chat" }],
    },
    server: {
      host: "127.0.0.1",
      port: 18800,
    },
    peers: [],
    security: {
      inboundAuth: "none",
      fileSecurity: {
        allowedMimeTypes: ["image/*", "application/pdf", "text/plain", "text/csv", "application/json", "audio/*", "video/*"],
        maxFileSizeBytes: 52_428_800,
        maxInlineFileSizeBytes: 10_485_760,
        fileUriAllowlist: [],
      },
    },
    routing: {
      defaultAgentId: "default-agent",
    },
    ...overrides,
  };
}

function createMockWebSocketClass(options?: {
  onAgent?: (params: Record<string, unknown>) => void;
  agentResponseText?: string;
  agentResponsePayloads?: Array<Record<string, unknown>>;
}) {
  const agentResponseText = options?.agentResponseText ?? "Gateway response";
  const agentResponsePayloads = options?.agentResponsePayloads;

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
              payload: { nonce: "test-nonce-123" },
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
      if (frame.method === "sessions.resolve") {
        this.respond(frame.id, true, { key: "session-1" });
        return;
      }
      if (frame.method === "agent") {
        options?.onAgent?.(frame.params || {});
        this.respond(frame.id, true, { status: "accepted" });
        const payloads = agentResponsePayloads ?? [{ kind: "text", text: agentResponseText }];
        this.respond(frame.id, true, {
          status: "ok",
          result: { payloads },
        });
        return;
      }
      this.respond(frame.id, false, null, { message: `unsupported method ${frame.method}` });
    }

    close(): void {
      this.readyState = 3;
      this.emit("close", {});
    }

    addEventListener(type: string, listener: (event: any) => void): void {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type)?.add(listener);
    }

    removeEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    private respond(id: string, ok: boolean, payload?: unknown, error?: unknown): void {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            type: "res",
            id,
            ok,
            payload,
            error,
          }),
        });
      });
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
      }
    }
  };
}

function createApi() {
  return {
    config: { gateway: { port: 18789 } },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as any;
}

function createEventBus() {
  const events: unknown[] = [];
  let finishedCalled = false;

  return {
    events,
    isFinished: () => finishedCalled,
    bus: {
      publish(event: unknown) {
        events.push(event);
      },
      finished() {
        finishedCalled = true;
      },
    } as any,
  };
}

async function executeRound(executor: OpenClawAgentExecutor, taskId: string, contextId: string): Promise<void> {
  const eventBus = createEventBus();

  await executor.execute(
    {
      taskId,
      contextId,
      userMessage: {
        kind: "message",
        messageId: `msg-${taskId}`,
        role: "user",
        agentId: "writer-agent",
        parts: [{ kind: "text", text: `hello-${taskId}` }],
      },
    } as any,
    eventBus.bus,
  );

  assert.equal(eventBus.isFinished(), true);
  assert.equal((eventBus.events.at(-1) as Task).status.state, "completed");
}

describe("multi-round conversation routing", () => {
  it("reuses the same sessionKey for two rounds with the same contextId", async () => {
    const sessionKeys: string[] = [];
    const MockWS = createMockWebSocketClass({
      onAgent: (params) => {
        if (typeof params.sessionKey === "string") {
          sessionKeys.push(params.sessionKey);
        }
      },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);

      await executeRound(executor, "task-round-1", "ctx-round");
      await executeRound(executor, "task-round-2", "ctx-round");

      assert.deepEqual(sessionKeys, [
        "agent:writer-agent:a2a:ctx-round",
        "agent:writer-agent:a2a:ctx-round",
      ]);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("uses different sessionKeys for different contextIds", async () => {
    const sessionKeys: string[] = [];
    const MockWS = createMockWebSocketClass({
      onAgent: (params) => {
        if (typeof params.sessionKey === "string") {
          sessionKeys.push(params.sessionKey);
        }
      },
    });

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);

      await executeRound(executor, "task-ctx-a", "ctx-a");
      await executeRound(executor, "task-ctx-b", "ctx-b");

      assert.equal(sessionKeys.length, 2);
      assert.notEqual(sessionKeys[0], sessionKeys[1]);
      assert.equal(sessionKeys[0], "agent:writer-agent:a2a:ctx-a");
      assert.equal(sessionKeys[1], "agent:writer-agent:a2a:ctx-b");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("keeps taskContextByTaskId mapped for multiple taskIds in the same context", async () => {
    const MockWS = createMockWebSocketClass();
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);

      await executeRound(executor, "task-map-1", "ctx-shared");
      await executeRound(executor, "task-map-2", "ctx-shared");

      const taskContextByTaskId = (executor as any).taskContextByTaskId as Map<string, string>;
      assert.equal(taskContextByTaskId.get("task-map-1"), "ctx-shared");
      assert.equal(taskContextByTaskId.get("task-map-2"), "ctx-shared");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

describe("history preservation across rounds", () => {
  it("completed task carries forward existing history from requestContext.task", async () => {
    const MockWS = createMockWebSocketClass({
      agentResponseText: "round-2 response",
    });
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);
      const eventBus = createEventBus();

      // Simulate a second-round request where the SDK passes the task
      // with history from the first round.
      const previousHistory = [
        {
          kind: "message" as const,
          messageId: "msg-round-1-user",
          role: "user" as const,
          contextId: "ctx-hist",
          parts: [{ kind: "text" as const, text: "round-1 question" }],
        },
        {
          kind: "message" as const,
          messageId: "msg-round-1-agent",
          role: "agent" as const,
          contextId: "ctx-hist",
          parts: [{ kind: "text" as const, text: "round-1 answer" }],
        },
      ];

      await executor.execute(
        {
          taskId: "task-hist-2",
          contextId: "ctx-hist",
          task: {
            kind: "task",
            id: "task-hist-2",
            contextId: "ctx-hist",
            status: { state: "working", timestamp: new Date().toISOString() },
            history: previousHistory,
          },
          userMessage: {
            kind: "message",
            messageId: "msg-round-2-user",
            role: "user",
            parts: [{ kind: "text", text: "round-2 question" }],
          },
        } as any,
        eventBus.bus,
      );

      assert.equal(eventBus.isFinished(), true);

      // The completed task must carry the previous history
      const completedTask = eventBus.events.at(-1) as Task;
      assert.equal(completedTask.status.state, "completed");
      assert.ok(completedTask.history, "completed task should have history");
      assert.equal(completedTask.history!.length, 2, "should carry 2 previous messages");
      assert.equal((completedTask.history![0] as any).messageId, "msg-round-1-user");
      assert.equal((completedTask.history![1] as any).messageId, "msg-round-1-agent");

      // The working event should also carry history
      const workingTask = eventBus.events[0] as Task;
      assert.ok(workingTask.history, "working task should have history");
      assert.equal(workingTask.history!.length, 2);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("truncates history exceeding MAX_HISTORY_MESSAGES (200)", async () => {
    const MockWS = createMockWebSocketClass();
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);
      const eventBus = createEventBus();

      // Build a history with 250 messages (exceeds the 200 cap)
      const bigHistory = Array.from({ length: 250 }, (_, i) => ({
        kind: "message" as const,
        messageId: `msg-${i}`,
        role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
        contextId: "ctx-big",
        parts: [{ kind: "text" as const, text: `message ${i}` }],
      }));

      await executor.execute(
        {
          taskId: "task-big",
          contextId: "ctx-big",
          task: {
            kind: "task",
            id: "task-big",
            contextId: "ctx-big",
            status: { state: "working", timestamp: new Date().toISOString() },
            history: bigHistory,
          },
          userMessage: {
            kind: "message",
            messageId: "msg-big-next",
            role: "user",
            parts: [{ kind: "text", text: "next" }],
          },
        } as any,
        eventBus.bus,
      );

      const completedTask = eventBus.events.at(-1) as Task;
      assert.equal(completedTask.status.state, "completed");
      assert.ok(completedTask.history, "should have history");
      assert.equal(completedTask.history!.length, 200, "should cap at 200 messages");
      // Should keep the LATEST 200 (indices 50-249)
      assert.equal((completedTask.history![0] as any).messageId, "msg-50");
      assert.equal((completedTask.history![199] as any).messageId, "msg-249");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("first round (no prior task) has empty history", async () => {
    const MockWS = createMockWebSocketClass();
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWS;

    try {
      const executor = new OpenClawAgentExecutor(createApi(), makeConfig() as GatewayConfig);
      const eventBus = createEventBus();

      await executor.execute(
        {
          taskId: "task-first",
          contextId: "ctx-first",
          userMessage: {
            kind: "message",
            messageId: "msg-first",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        } as any,
        eventBus.bus,
      );

      const completedTask = eventBus.events.at(-1) as Task;
      assert.equal(completedTask.status.state, "completed");
      assert.ok(Array.isArray(completedTask.history), "history should be an array");
      assert.equal(completedTask.history!.length, 0, "first round should have empty history");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

describe("FileTaskStore multi-round persistence", () => {
  it("keeps the latest saved task state after multiple saves", async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), "a2a-gateway-multi-round-"));

    try {
      const store = new FileTaskStore(tasksDir);

      await store.save({
        kind: "task",
        id: "task-1",
        contextId: "ctx-round",
        status: {
          state: "working",
          timestamp: new Date().toISOString(),
        },
      } as Task);

      await store.save({
        kind: "task",
        id: "task-1",
        contextId: "ctx-round",
        status: {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: {
            kind: "message",
            messageId: "msg-task-1-completed",
            role: "agent",
            contextId: "ctx-round",
            parts: [{ kind: "text", text: "latest-completed-message" }],
          },
        },
      } as Task);

      const restored = await store.load("task-1");

      assert.ok(restored, "task should load after repeated saves");
      assert.equal(restored.status.state, "completed");
      assert.equal(restored.status.message?.parts?.[0]?.kind, "text");
      assert.equal(restored.status.message?.parts?.[0]?.text, "latest-completed-message");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
