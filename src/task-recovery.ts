import { randomUUID } from "node:crypto";

import { Role, TaskState } from "@a2a-js/sdk";

import type { FileTaskStore } from "./task-store.js";
import { taskStateName, textPart, v1Message } from "./types-v1.js";

type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

/** Terminal states that should NOT be recovered — mirrors task-cleanup.ts */
const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const ACTIVE_RECOVERIES = new WeakSet<FileTaskStore>();

export interface RecoveryResult {
  recovered: number;
  skipped: number;
  errors: number;
}

/**
 * Scan the task store at startup and mark any tasks stuck in non-terminal
 * states (submitted/working/input-required/auth-required/unknown) as failed.
 *
 * Uses a terminal-state allowlist so that any future non-terminal states
 * are automatically covered.
 *
 * This closes the lifecycle gap where a gateway restart leaves old tasks
 * hanging indefinitely. No auto-retry or DLQ — just a clean fail with a
 * clear reason.
 */
export async function recoverStaleTasks(
  store: FileTaskStore,
  logger: LoggerLike,
): Promise<RecoveryResult> {
  if (ACTIVE_RECOVERIES.has(store)) {
    return { recovered: 0, skipped: 0, errors: 0 };
  }

  ACTIVE_RECOVERIES.add(store);
  const result: RecoveryResult = { recovered: 0, skipped: 0, errors: 0 };

  try {
    let taskIds: string[];
    try {
      taskIds = await store.listAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`a2a-gateway: task recovery failed to list tasks: ${msg}`);
      return result;
    }

    if (taskIds.length === 0) {
      return result;
    }

    for (const taskId of taskIds) {
      try {
        const task = await store.load(taskId);
        if (!task) {
          continue;
        }

        const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        if (TERMINAL_STATES.has(state)) {
          result.skipped += 1;
          continue;
        }

        if (!task.status) {
          task.status = { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: undefined };
        }
        task.status.state = TaskState.TASK_STATE_FAILED;
        task.status.timestamp = new Date().toISOString();
        task.status.message = v1Message({
          messageId: randomUUID(),
          role: Role.ROLE_AGENT,
          parts: [
            textPart(`gateway restarted before task completed (was: ${taskStateName(state)})`),
          ],
          contextId: task.contextId,
          taskId: task.id,
        });

        await store.save(task);
        result.recovered += 1;

        logger.info(
          `a2a-gateway: recovered stale task ${taskId} (${state} → failed)`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`a2a-gateway: task recovery error for ${taskId}: ${msg}`);
        result.errors += 1;
      }
    }

    if (result.recovered > 0 || result.errors > 0) {
      logger.info(
        `a2a-gateway: task recovery completed — recovered=${result.recovered} skipped=${result.skipped} errors=${result.errors}`,
      );
    }

    return result;
  } finally {
    ACTIVE_RECOVERIES.delete(store);
  }
}
