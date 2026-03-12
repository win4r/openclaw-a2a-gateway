import type { FileTaskStore } from "./task-store.js";
import type { GatewayTelemetry } from "./telemetry.js";

type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

/** Terminal states that are safe to expire. */
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
const ACTIVE_CLEANUPS = new WeakSet<FileTaskStore>();

export interface CleanupResult {
  expired: number;
  skipped: number;
  errors: number;
}

/**
 * Scan the task store and delete tasks that:
 * 1. Are in a terminal state (completed/failed/canceled/rejected)
 * 2. Have a `status.timestamp` older than `ttlMs`
 *
 * Active tasks and tasks without a timestamp are always skipped.
 */
export async function runTaskCleanup(
  store: FileTaskStore,
  ttlMs: number,
  telemetry: GatewayTelemetry,
  logger: LoggerLike,
): Promise<CleanupResult> {
  if (ACTIVE_CLEANUPS.has(store)) {
    return { expired: 0, skipped: 0, errors: 0 };
  }

  ACTIVE_CLEANUPS.add(store);
  const result: CleanupResult = { expired: 0, skipped: 0, errors: 0 };
  const now = Date.now();

  try {
    let taskIds: string[];
    try {
      taskIds = await store.listAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`a2a-gateway: task cleanup failed to list tasks: ${msg}`);
      return result;
    }

    if (taskIds.length === 0) {
      return result;
    }

    for (const taskId of taskIds) {
      try {
        const task = await store.load(taskId);
        if (!task) {
          // File disappeared between listAll and load — not an error
          continue;
        }

        const { state } = task.status;
        if (!TERMINAL_STATES.has(state)) {
          result.skipped += 1;
          continue;
        }

        const timestamp = task.status.timestamp;
        if (!timestamp) {
          // No timestamp -> can't determine age -> skip
          result.skipped += 1;
          continue;
        }

        const age = now - new Date(timestamp).getTime();
        if (isNaN(age) || age < ttlMs) {
          result.skipped += 1;
          continue;
        }

        const deleted = await store.delete(taskId);
        if (!deleted) {
          result.skipped += 1;
          continue;
        }

        telemetry.recordTaskExpired(taskId, state);
        result.expired += 1;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`a2a-gateway: task cleanup error for ${taskId}: ${msg}`);
        result.errors += 1;
      }
    }

    if (result.expired > 0) {
      logger.info(
        `a2a-gateway: task cleanup completed - expired=${result.expired} skipped=${result.skipped} errors=${result.errors}`,
      );
    }

    return result;
  } finally {
    ACTIVE_CLEANUPS.delete(store);
  }
}
