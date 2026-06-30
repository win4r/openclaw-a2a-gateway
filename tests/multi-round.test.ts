import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";

import { OpenClawAgentExecutor } from "../src/executor.js";
import { FileTaskStore } from "../src/task-store.js";
import type { GatewayConfig } from "../src/types.js";

import {
  createApi,
  createEventBus,
  createMockWebSocketClass,
  lastPublishedTask,
  makeConfig,
  partTextFromJson,
  TaskState,
} from "./helpers.js";

async function executeRound(executor: OpenClawAgentExecutor, taskId: string, contextId: string): Promise<void> {
  const eventBus = createEventBus();

  await executor.execute(
    {
      taskId,
      contextId,
      userMessage: {
                messageId: `msg-${taskId}`,
        role: "ROLE_USER",
        agentId: "writer-agent",
        parts: [{ text: `hello-${taskId}` }],
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
          role: "ROLE_USER" as const,
          contextId: "ctx-hist",
          parts: [{ text: "round-1 question" }],
        },
        {
          kind: "message" as const,
          messageId: "msg-round-1-agent",
          role: "ROLE_AGENT" as const,
          contextId: "ctx-hist",
          parts: [{ text: "round-1 answer" }],
        },
      ];

      await executor.execute(
        {
          taskId: "task-hist-2",
          contextId: "ctx-hist",
          task: {
                        id: "task-hist-2",
            contextId: "ctx-hist",
            status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
            history: previousHistory,
          },
          userMessage: {
                        messageId: "msg-round-2-user",
            role: "ROLE_USER",
            parts: [{ text: "round-2 question" }],
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
        parts: [{ text: `message ${i}` }],
      }));

      await executor.execute(
        {
          taskId: "task-big",
          contextId: "ctx-big",
          task: {
                        id: "task-big",
            contextId: "ctx-big",
            status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
            history: bigHistory,
          },
          userMessage: {
                        messageId: "msg-big-next",
            role: "ROLE_USER",
            parts: [{ text: "next" }],
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
                        messageId: "msg-first",
            role: "ROLE_USER",
            parts: [{ text: "hello" }],
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
                id: "task-1",
        contextId: "ctx-round",
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: new Date().toISOString(),
        },
      } as Task);

      await store.save({
                id: "task-1",
        contextId: "ctx-round",
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          timestamp: new Date().toISOString(),
          message: {
                        messageId: "msg-task-1-completed",
            role: "ROLE_AGENT",
            contextId: "ctx-round",
            parts: [{ text: "latest-completed-message" }],
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
