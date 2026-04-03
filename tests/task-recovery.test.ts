import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";

import { recoverStaleTasks } from "../src/task-recovery.js";
import { FileTaskStore } from "../src/task-store.js";

import { silentLogger } from "./helpers.js";

function makeTask(
  taskId: string,
  state: string,
  timestamp?: string,
): Task {
  return {
    kind: "task",
    id: taskId,
    contextId: `ctx-${taskId}`,
    status: {
      state: state as any,
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
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
      await store.save(makeTask("task-sub", "submitted", hoursAgo(2)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);

      const task = await store.load("task-sub");
      assert.ok(task);
      assert.equal(task.status.state, "failed");
      assert.ok(task.status.timestamp);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks working tasks as failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("task-work", "working", hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 1);

      const task = await store.load("task-work");
      assert.ok(task);
      assert.equal(task.status.state, "failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers all non-terminal states (input-required, auth-required, unknown)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t-input", "input-required", hoursAgo(1)));
      await store.save(makeTask("t-auth", "auth-required", hoursAgo(1)));
      await store.save(makeTask("t-unknown", "unknown", hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 3);
      assert.equal(result.skipped, 0);

      assert.equal((await store.load("t-input"))!.status.state, "failed");
      assert.equal((await store.load("t-auth"))!.status.state, "failed");
      assert.equal((await store.load("t-unknown"))!.status.state, "failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips tasks already in terminal states", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t-completed", "completed", hoursAgo(1)));
      await store.save(makeTask("t-failed", "failed", hoursAgo(1)));
      await store.save(makeTask("t-canceled", "canceled", hoursAgo(1)));
      await store.save(makeTask("t-rejected", "rejected", hoursAgo(1)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 0);
      assert.equal(result.skipped, 4);

      assert.equal((await store.load("t-completed"))!.status.state, "completed");
      assert.equal((await store.load("t-failed"))!.status.state, "failed");
      assert.equal((await store.load("t-canceled"))!.status.state, "canceled");
      assert.equal((await store.load("t-rejected"))!.status.state, "rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles mixed terminal and non-terminal tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("t1", "submitted", hoursAgo(5)));
      await store.save(makeTask("t2", "completed", hoursAgo(1)));
      await store.save(makeTask("t3", "working", hoursAgo(3)));
      await store.save(makeTask("t4", "failed", hoursAgo(2)));

      const result = await recoverStaleTasks(store, silentLogger());
      assert.equal(result.recovered, 2);
      assert.equal(result.skipped, 2);

      assert.equal((await store.load("t1"))!.status.state, "failed");
      assert.equal((await store.load("t2"))!.status.state, "completed");
      assert.equal((await store.load("t3"))!.status.state, "failed");
      assert.equal((await store.load("t4"))!.status.state, "failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a complete Message2 with kind and messageId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-recovery-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("task-msg", "working", hoursAgo(1)));

      await recoverStaleTasks(store, silentLogger());

      const task = await store.load("task-msg");
      assert.ok(task);
      const message = task.status.message;
      assert.ok(message);
      assert.equal(message.kind, "message");
      assert.ok(message.messageId, "messageId must be present");
      assert.equal(message.role, "agent");
      assert.ok(message.parts.length > 0);
      const text = (message.parts[0] as any).text;
      assert.ok(text.includes("was: working"));
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
