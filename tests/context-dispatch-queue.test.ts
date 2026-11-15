/**
 * Tests for per-contextId dispatch queue serialization.
 *
 * Exercises the real enqueueDispatch() helper from src/dispatch-queue.ts
 * to verify that concurrent A2A tasks sharing the same contextId are
 * dispatched sequentially, preventing race conditions on the session file.
 *
 * @see https://github.com/win4r/openclaw-a2a-gateway/issues/81
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enqueueDispatch } from "../src/dispatch-queue.js";

describe("per-contextId dispatch queue", () => {
  it("serializes two concurrent tasks with the same contextId", async () => {
    const queues = new Map<string, Promise<void>>();
    const order: string[] = [];

    async function task1() {
      order.push("task1:start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("task1:end");
      return "result1";
    }

    async function task2() {
      order.push("task2:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("task2:end");
      return "result2";
    }

    const [r1, r2] = await Promise.all([
      enqueueDispatch(queues, "ctx-1", task1),
      enqueueDispatch(queues, "ctx-1", task2),
    ]);

    assert.equal(r1, "result1");
    assert.equal(r2, "result2");

    // task1 must fully complete before task2 starts
    assert.deepEqual(order, ["task1:start", "task1:end", "task2:start", "task2:end"]);
  });

  it("allows concurrent dispatch for different contextIds", async () => {
    const queues = new Map<string, Promise<void>>();
    const order: string[] = [];

    async function taskA() {
      order.push("A:start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("A:end");
      return "A";
    }

    async function taskB() {
      order.push("B:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("B:end");
      return "B";
    }

    // Different contextIds — should run concurrently
    const [rA, rB] = await Promise.all([
      enqueueDispatch(queues, "ctx-1", taskA),
      enqueueDispatch(queues, "ctx-2", taskB),
    ]);

    assert.equal(rA, "A");
    assert.equal(rB, "B");

    // B should start before A ends (concurrent execution)
    assert.ok(
      order.indexOf("B:start") < order.indexOf("A:end"),
      `Expected B to start before A ends. Order: ${JSON.stringify(order)}`,
    );
  });

  it("does not poison the chain when a task fails", async () => {
    const queues = new Map<string, Promise<void>>();
    const order: string[] = [];

    async function failingTask() {
      order.push("fail:start");
      throw new Error("boom");
    }

    async function successTask() {
      order.push("success:start");
      return "ok";
    }

    // First task fails, second should still run
    await assert.rejects(() => enqueueDispatch(queues, "ctx-1", failingTask), {
      message: "boom",
    });
    const result = await enqueueDispatch(queues, "ctx-1", successTask);

    assert.equal(result, "ok");
    assert.deepEqual(order, ["fail:start", "success:start"]);
  });

  it("cleans up queue entries after chain settles", async () => {
    const queues = new Map<string, Promise<void>>();

    await enqueueDispatch(queues, "ctx-cleanup", async () => "done");

    // Allow microtask queue to flush (.finally() runs async)
    await new Promise((r) => setTimeout(r, 0));

    // Entry should be removed after completion
    assert.equal(queues.has("ctx-cleanup"), false);
  });
});
