import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus } from "@a2a-js/sdk/server";

import { textPart } from "../src/types-v1.js";
import { QueueingAgentExecutor } from "../src/queueing-executor.js";
import { FileTaskStore } from "../src/task-store.js";
import { GatewayTelemetry } from "../src/telemetry.js";

import { silentLogger } from "./helpers.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createEventBus() {
  const events: unknown[] = [];
  let finished = false;

  const bus: ExecutionEventBus = {
    publish(event) {
      events.push(event);
    },
    on() {
      return bus;
    },
    off() {
      return bus;
    },
    once() {
      return bus;
    },
    removeAllListeners() {
      return bus;
    },
    finished() {
      finished = true;
    },
  };

  return {
    bus,
    events,
    isFinished: () => finished,
  };
}

function makeTask(taskId: string): Task {
  return {
    id: taskId,
    contextId: `ctx-${taskId}`,
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: undefined,
    },
    artifacts: [
      {
        artifactId: `artifact-${taskId}`,
        name: "",
        description: "",
        parts: [textPart(`done-${taskId}`)],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  };
}

/** Unwrap a v1 execution event into its task payload (or undefined). */
function taskPayload(event: unknown): Task | undefined {
  const ev = event as AgentExecutionEvent;
  return ev?.kind === "task" ? ev.data : undefined;
}

function makeRequestContext(taskId: string) {
  return {
    taskId,
    contextId: `ctx-${taskId}`,
    userMessage: {
      kind: "message",
      messageId: `msg-${taskId}`,
      role: "user",
      parts: [{ kind: "text", text: `hello-${taskId}` }],
    },
  } as any;
}

describe("P0 runtime components", () => {
  it("FileTaskStore persists tasks across instances", async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), "a2a-gateway-task-store-"));

    try {
      const writer = new FileTaskStore(tasksDir);
      await writer.save(makeTask("task-1"));

      const reader = new FileTaskStore(tasksDir);
      const restored = await reader.load("task-1");

      assert.ok(restored, "task should be restored from disk");
      assert.equal(restored.id, "task-1");
      assert.equal(restored.artifacts?.[0]?.parts?.[0]?.content?.$case, "text");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("QueueingAgentExecutor queues overflow safely and tracks metrics", async () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });

    const gates = new Map<string, ReturnType<typeof createDeferred>>();
    gates.set("task-1", createDeferred());
    gates.set("task-2", createDeferred());

    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        await gates.get(requestContext.taskId)?.promise;
        eventBus.publish({ kind: "task", data: makeTask(requestContext.taskId) });
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 1,
    });

    const bus1 = createEventBus();
    const bus2 = createEventBus();
    const bus3 = createEventBus();

    const p1 = executor.execute(makeRequestContext("task-1"), bus1.bus);
    const p2 = executor.execute(makeRequestContext("task-2"), bus2.bus);
    const p3 = executor.execute(makeRequestContext("task-3"), bus3.bus);

    await Promise.resolve();

    assert.equal(taskPayload(bus2.events[0])?.status?.state, TaskState.TASK_STATE_SUBMITTED);
    assert.equal(taskPayload(bus3.events[0])?.status?.state, TaskState.TASK_STATE_REJECTED);
    assert.equal(bus3.isFinished(), true);

    gates.get("task-1")?.resolve();
    await p1;

    await new Promise((resolve) => setTimeout(resolve, 0));
    gates.get("task-2")?.resolve();
    await p2;
    await p3;

    assert.equal(taskPayload(bus1.events.at(-1))?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(taskPayload(bus2.events.at(-1))?.status?.state, TaskState.TASK_STATE_COMPLETED);

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.tasks.started, 2);
    assert.equal(snapshot.tasks.completed, 2);
    assert.equal(snapshot.tasks.queue_rejections, 1);
    assert.equal(snapshot.tasks.rejected, 1);
    assert.equal(snapshot.tasks.queued, 1);
  });

  it("QueueingAgentExecutor closes a resource-owning delegate", () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });
    let closed = false;
    const delegate: AgentExecutor & { close(): void } = {
      async execute() {},
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
      close() {
        closed = true;
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 0,
    });

    executor.close();
    assert.equal(closed, true);
  });
});
