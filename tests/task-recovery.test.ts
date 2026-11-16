import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { Role, TaskState } from "@a2a-js/sdk";
import type { Task } from "@a2a-js/sdk";

import { recoverStaleTasks } from "../src/task-recovery.js";
import { FileTaskStore } from "../src/task-store.js";

import { silentLogger } from "./helpers.js";

function makeTask(
  taskId: string,
  state: TaskState,
  timestamp?: string,
): Task {
  return {
    id: taskId,
    contextId: `ctx-${taskId}`,
    status: {
      state,
      message: undefined,
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

describe("recoverStaleTasks", () => {
  it("marks submitted tasks as failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("task-sub", TaskState.TASK_STATE_SUBMITTED, hoursAgo(2)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);

      const task = await store.load("task-sub");
      assert.ok(task);
      assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
      assert.ok(task.status.timestamp);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks working tasks as failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("task-work", TaskState.TASK_STATE_WORKING, hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 1);

      const task = await store.load("task-work");
      assert.ok(task);
      assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers all non-terminal states (input-required, auth-required, unknown)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t-input", TaskState.TASK_STATE_INPUT_REQUIRED, hoursAgo(1)));
      await store.save(makeTask("t-auth", TaskState.TASK_STATE_AUTH_REQUIRED, hoursAgo(1)));
      await store.save(makeTask("t-unknown", TaskState.TASK_STATE_UNSPECIFIED, hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 3);
      assert.equal(result.skipped, 0);

      assert.equal((await store.load("t-input"))!.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal((await store.load("t-auth"))!.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal((await store.load("t-unknown"))!.status.state, TaskState.TASK_STATE_FAILED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips tasks already in terminal states", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t-completed", TaskState.TASK_STATE_COMPLETED, hoursAgo(1)));
      await store.save(makeTask("t-failed", TaskState.TASK_STATE_FAILED, hoursAgo(1)));
      await store.save(makeTask("t-canceled", TaskState.TASK_STATE_CANCELED, hoursAgo(1)));
      await store.save(makeTask("t-rejected", TaskState.TASK_STATE_REJECTED, hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 0);
      assert.equal(result.skipped, 4);

      assert.equal((await store.load("t-completed"))!.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal((await store.load("t-failed"))!.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal((await store.load("t-canceled"))!.status.state, TaskState.TASK_STATE_CANCELED);
      assert.equal((await store.load("t-rejected"))!.status.state, TaskState.TASK_STATE_REJECTED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles mixed terminal and non-terminal tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t1", TaskState.TASK_STATE_SUBMITTED, hoursAgo(5)));
      await store.save(makeTask("t2", TaskState.TASK_STATE_COMPLETED, hoursAgo(1)));
      await store.save(makeTask("t3", TaskState.TASK_STATE_WORKING, hoursAgo(3)));
      await store.save(makeTask("t4", TaskState.TASK_STATE_FAILED, hoursAgo(2)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 2);
      assert.equal(result.skipped, 2);

      assert.equal((await store.load("t1"))!.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal((await store.load("t2"))!.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal((await store.load("t3"))!.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal((await store.load("t4"))!.status.state, TaskState.TASK_STATE_FAILED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a complete Message2 with kind and messageId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("task-msg", TaskState.TASK_STATE_WORKING, hoursAgo(1)));

      await recoverStaleTasks(store, silentLogger());

      const task = await store.load("task-msg");
      assert.ok(task);
      const message = task.status.message;
      assert.ok(message);
      assert.ok(message.messageId, "messageId must be present");
      assert.equal(message.role, Role.ROLE_AGENT);
      assert.ok(message.parts.length > 0);
      const first = message.parts[0] as any;
      assert.equal(first.content?.$case, "text");
      const text = String(first.content?.value ?? "");
      // taskStateName() renders lowercase wire names ("working")
      assert.equal(text.includes("was: working"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns zeros when task directory is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns zeros when task directory does not exist", async () => {
    const store = new FileTaskStore("/tmp/a2a-recovery-nonexistent-xyz");
    const result = await recoverStaleTasks(store, silentLogger());
    assert.equal(result.recovered, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
  });
});
