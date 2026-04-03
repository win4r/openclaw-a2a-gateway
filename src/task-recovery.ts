import type { FileTaskStore } from "./task-store.js";

type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

const NON_TERMINAL_STATES = new Set(["submitted", "working"]);

export interface RecoveryResult {
  recovered: number;
  skipped: number;
  errors: number;
}

/**
 * Scan the task store at startup and mark any tasks stuck in non-terminal
 * states (submitted/working) as failed.
 *
 * This closes the lifecycle gap where a gateway restart leaves old tasks
 * hanging indefinitely. No auto-retry or DLQ — just a clean fail with a
 * clear reason.
 */
export async function recoverStaleTasks(
  store: FileTaskStore,
  logger: LoggerLike,
): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, skipped: 0, errors: 0 };

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

      if (!NON_TERMINAL_STATES.has(task.status.state)) {
        result.skipped += 1;
        continue;
      }

      const previousState = task.status.state;
      task.status.state = "failed" as any;
      task.status.timestamp = new Date().toISOString();
      task.status.message = {
        role: "agent",
        parts: [
          {
            kind: "text",
            text: `gateway restarted before task completed (was: ${previousState})`,
          },
        ],
      } as any;

      await store.save(task);
      result.recovered += 1;

      logger.info(
        `a2a-gateway: recovered stale task ${taskId} (${previousState} → failed)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`a2a-gateway: task recovery error for ${taskId}: ${msg}`);
      result.errors += 1;
    }
  }

  if (result.recovered > 0) {
    logger.info(
      `a2a-gateway: task recovery completed — recovered=${result.recovered} skipped=${result.skipped} errors=${result.errors}`,
    );
  }

  return result;
}
