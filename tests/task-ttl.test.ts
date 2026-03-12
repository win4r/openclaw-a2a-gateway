import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";

import { runTaskCleanup } from "../src/task-cleanup.js";
import { FileTaskStore } from "../src/task-store.js";
import { GatewayTelemetry } from "../src/telemetry.js";

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  } as any;
}

function makeTelemetry() {
  return new GatewayTelemetry(silentLogger(), { structuredLogs: false });
}

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

describe("FileTaskStore extensions", () => {
  it("listAll returns all stored task IDs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-list-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("alpha-uno", "completed", hoursAgo(1)));
      await store.save(makeTask("beta-dos", "failed", hoursAgo(2)));
      await store.save(makeTask("gamma-tres", "working", hoursAgo(3)));

      const ids = await store.listAll();
      assert.equal(ids.length, 3);
      assert.ok(ids.includes("alpha-uno"));
      assert.ok(ids.includes("beta-dos"));
      assert.ok(ids.includes("gamma-tres"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("listAll returns empty array when directory does not exist", async () => {
    const store = new FileTaskStore("/tmp/a2a-ttl-nonexistent-dir-xyz");
    const ids = await store.listAll();
    assert.equal(ids.length, 0);
  });

  it("delete removes a task file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-del-"));
    try {
      const store = new FileTaskStore(dir);
      await store.save(makeTask("doomed-task", "completed", hoursAgo(1)));

      const before = await store.load("doomed-task");
      assert.ok(before, "task should exist before delete");

      const deleted = await store.delete("doomed-task");

      const after = await store.load("doomed-task");
      assert.equal(deleted, true, "delete should report that it removed a task");
      assert.equal(after, undefined, "task should be gone after delete");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("delete silently ignores non-existent task", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-delnx-"));
    try {
      const store = new FileTaskStore(dir);
      const deleted = await store.delete("ghost-task-42");
      assert.equal(deleted, false, "delete should report when nothing was removed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mkdir lazy init: directory created only once", async () => {
    const dir = path.join(os.tmpdir(), `a2a-ttl-lazy-${Date.now()}`);
    try {
      const store = new FileTaskStore(dir);

      // Directory should not exist yet
      let exists = false;
      try {
        await readdir(dir);
        exists = true;
      } catch {
        exists = false;
      }
      assert.equal(exists, false, "dir should not exist before first save");

      // First save creates the directory
      await store.save(makeTask("lazy-1", "completed", hoursAgo(1)));
      const entries1 = await readdir(dir);
      assert.equal(entries1.length, 1);

      // Second save reuses the directory (no error)
      await store.save(makeTask("lazy-2", "completed", hoursAgo(1)));
      const entries2 = await readdir(dir);
      assert.equal(entries2.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries directory creation after a transient mkdir failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-dirrecover-"));
    const blocker = path.join(root, "blocked");
    try {
      await writeFile(blocker, "x", "utf8");
      const store = new FileTaskStore(path.join(blocker, "tasks"));

      await assert.rejects(
        store.save(makeTask("first-attempt", "completed", hoursAgo(1))),
        (error: unknown) => (error as { code?: string } | undefined)?.code === "ENOTDIR",
      );

      await rm(blocker, { force: true });
      await mkdir(blocker, { recursive: true });

      await store.save(makeTask("second-attempt", "completed", hoursAgo(1)));
      const recovered = await store.load("second-attempt");
      assert.ok(recovered, "save should recover once the directory path becomes valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Task TTL cleanup", () => {
  it("expires terminal tasks older than TTL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-expire-"));
    try {
      const store = new FileTaskStore(dir);
      const telemetry = makeTelemetry();

      // Old terminal tasks — should be expired
      await store.save(makeTask("old-completed-999", "completed", hoursAgo(100)));
      await store.save(makeTask("old-failed-888", "failed", hoursAgo(200)));
      await store.save(makeTask("old-canceled-777", "canceled", hoursAgo(150)));
      await store.save(makeTask("old-rejected-666", "rejected", hoursAgo(80)));

      // Fresh terminal task — should survive
      await store.save(makeTask("fresh-completed-111", "completed", hoursAgo(1)));

      const ttl72h = 72 * 3_600_000;
      const result = await runTaskCleanup(store, ttl72h, telemetry, silentLogger());

      assert.equal(result.expired, 4, "4 old terminal tasks should be expired");
      assert.equal(result.skipped, 1, "1 fresh task should be skipped");

      // Verify expired tasks are gone
      assert.equal(await store.load("old-completed-999"), undefined);
      assert.equal(await store.load("old-failed-888"), undefined);
      assert.equal(await store.load("old-canceled-777"), undefined);
      assert.equal(await store.load("old-rejected-666"), undefined);

      // Verify fresh task survives
      const fresh = await store.load("fresh-completed-111");
      assert.ok(fresh, "fresh task should survive");

      // Verify telemetry
      const snap = telemetry.snapshot();
      assert.equal(snap.tasks.expired, 4);
      assert.ok(snap.tasks.last_cleanup_at, "last_cleanup_at should be set");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips active tasks even if older than TTL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-active-"));
    try {
      const store = new FileTaskStore(dir);
      const telemetry = makeTelemetry();

      // Old but active — must NOT be deleted
      await store.save(makeTask("working-ancient-555", "working", hoursAgo(500)));
      await store.save(makeTask("submitted-old-444", "submitted", hoursAgo(300)));
      await store.save(makeTask("input-required-333", "input-required", hoursAgo(200)));

      const ttl1h = 1 * 3_600_000;
      const result = await runTaskCleanup(store, ttl1h, telemetry, silentLogger());

      assert.equal(result.expired, 0, "no active tasks should be expired");
      assert.equal(result.skipped, 3, "all active tasks should be skipped");

      // Verify all still exist
      assert.ok(await store.load("working-ancient-555"));
      assert.ok(await store.load("submitted-old-444"));
      assert.ok(await store.load("input-required-333"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips tasks without timestamp", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-nots-"));
    try {
      const store = new FileTaskStore(dir);
      const telemetry = makeTelemetry();

      // Terminal but no timestamp — should skip
      await store.save(makeTask("no-timestamp-222", "completed"));

      const ttl1h = 1 * 3_600_000;
      const result = await runTaskCleanup(store, ttl1h, telemetry, silentLogger());

      assert.equal(result.expired, 0);
      assert.equal(result.skipped, 1);
      assert.ok(await store.load("no-timestamp-222"), "task without timestamp should survive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles empty task store gracefully", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-empty-"));
    try {
      const store = new FileTaskStore(dir);
      const telemetry = makeTelemetry();

      const result = await runTaskCleanup(store, 1, telemetry, silentLogger());

      assert.equal(result.expired, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles non-existent task store directory", async () => {
    const store = new FileTaskStore("/tmp/a2a-ttl-phantom-dir-xyz");
    const telemetry = makeTelemetry();

    const result = await runTaskCleanup(store, 1, telemetry, silentLogger());

    assert.equal(result.expired, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
  });

  it("skips overlapping cleanup runs for the same store", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a2a-ttl-overlap-"));
    try {
      const store = new FileTaskStore(dir);
      const telemetry = makeTelemetry();

      await store.save(makeTask("race-1", "completed", hoursAgo(100)));

      const [first, second] = await Promise.all([
        runTaskCleanup(store, 72 * 3_600_000, telemetry, silentLogger()),
        runTaskCleanup(store, 72 * 3_600_000, telemetry, silentLogger()),
      ]);

      assert.equal(first.expired, 1);
      assert.deepEqual(second, { expired: 0, skipped: 0, errors: 0 });
      assert.equal(telemetry.snapshot().tasks.expired, 1, "telemetry should count the task only once");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
