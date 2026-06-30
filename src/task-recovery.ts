import { TaskState } from "@a2a-js/sdk";

import { agentMessage, isTerminalTaskState, normalizeTaskState, textPart } from "./a2a/helpers.js";
import type { FileTaskStore } from "./task-store.js";

type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

const ACTIVE_RECOVERIES = new WeakSet<FileTaskStore>();

export interface RecoveryResult {
  recovered: number;
  skipped: number;
  errors: number;
}

/**
 * Scan the task store at startup and mark any tasks stuck in non-terminal
 * states (submitted/working/input-required/auth-required/unknown) as failed.
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

        const state = normalizeTaskState(task.status?.state);
        if (isTerminalTaskState(state)) {
          result.skipped += 1;
          continue;
        }

        task.status.state = TaskState.TASK_STATE_FAILED;
        task.status.timestamp = new Date().toISOString();
        task.status.message = agentMessage(
          task.contextId,
          [textPart(`gateway restarted before task completed (was: ${state})`)],
          task.id,
        );

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
