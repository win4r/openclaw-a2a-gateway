import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";

import { QueueingAgentExecutor } from "../src/queueing-executor.js";
import { FileTaskStore } from "../src/task-store.js";
import { GatewayTelemetry } from "../src/telemetry.js";

import { executionTaskState, partTextFromJson, silentLogger, TaskState } from "./helpers.js";

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
        parts: [{ content: { $case: "text", value: `done-${taskId}` }, metadata: undefined, filename: "", mediaType: "" }],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  };
}

function makeRequestContext(taskId: string) {
  return {
    taskId,
    contextId: `ctx-${taskId}`,
    userMessage: {
      messageId: `msg-${taskId}`,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: `hello-${taskId}` }, metadata: undefined, filename: "", mediaType: "" }],
      contextId: `ctx-${taskId}`,
      taskId,
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
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
      assert.equal(partTextFromJson(restored.artifacts?.[0]?.parts?.[0] as Record<string, unknown>), `done-task-1`);
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
        eventBus.publish(AgentEvent.task(makeTask(requestContext.taskId)));
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

    assert.equal(executionTaskState(bus2.events[0]), TaskState.TASK_STATE_SUBMITTED);
    assert.equal(executionTaskState(bus3.events[0]), TaskState.TASK_STATE_REJECTED);
    assert.equal(bus3.isFinished(), true);

    gates.get("task-1")?.resolve();
    await p1;

    await new Promise((resolve) => setTimeout(resolve, 0));
    gates.get("task-2")?.resolve();
    await p2;
    await p3;

    assert.equal(executionTaskState(bus1.events.at(-1)), TaskState.TASK_STATE_COMPLETED);
    assert.equal(executionTaskState(bus2.events.at(-1)), TaskState.TASK_STATE_COMPLETED);

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.tasks.started, 2);
    assert.equal(snapshot.tasks.completed, 2);
    assert.equal(snapshot.tasks.queue_rejections, 1);
    assert.equal(snapshot.tasks.rejected, 1);
    assert.equal(snapshot.tasks.queued, 1);
  });
});
