import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { TaskState } from "@a2a-js/sdk";
import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";

function cloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

/** Apply ListTasks projections (history truncation, artifact stripping). */
function projectTask(task: Task, params: ListTasksRequest): Task {
  const projected = cloneTask(task);

  if (!Array.isArray(projected.history)) {
    projected.history = [];
  } else if (params.historyLength !== undefined) {
    projected.history =
      params.historyLength === 0 ? [] : projected.history.slice(-params.historyLength);
  }

  if (!Array.isArray(projected.artifacts)) {
    projected.artifacts = [];
  } else if (!params.includeArtifacts) {
    projected.artifacts = [];
  }

  return projected;
}

function taskFileName(taskId: string): string {
  return `${encodeURIComponent(taskId)}.json`;
}

export class FileTaskStore implements TaskStore {
  private readonly tasksDir: string;
  private dirReady: Promise<void> | null = null;

  constructor(tasksDir: string) {
    this.tasksDir = path.resolve(tasksDir);
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    try {
      const payload = await readFile(this.taskPath(taskId), "utf8");
      return JSON.parse(payload) as Task;
    } catch (error: unknown) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.ensureDir();

    const nextTask = cloneTask(task);
    const targetPath = this.taskPath(task.id);
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(nextTask, null, 2)}\n`;

    await writeFile(tmpPath, payload, "utf8");

    // Windows: atomic rename can intermittently fail with EPERM/EACCES when the
    // destination file is being scanned/read. This breaks task polling.
    // Prefer rename (atomic), but fall back to direct write with cleanup.
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (error: unknown) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code !== "EPERM" && code !== "EACCES") {
        throw error;
      }

      // Retry a few times with small backoff; then fall back to overwrite.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
          await rename(tmpPath, targetPath);
          return;
        } catch (retryError: unknown) {
          const retryCode = (retryError as { code?: string } | undefined)?.code;
          if (retryCode !== "EPERM" && retryCode !== "EACCES") {
            throw retryError;
          }
        }
      }

      // Non-atomic fallback (best-effort).
      await writeFile(targetPath, payload, "utf8");
      try {
        await unlink(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  /**
   * v1 TaskStore.list \u2014 filesystem-backed listing with filtering and
   * offset-based pagination (page token encodes the next offset).
   */
  async list(params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    const ids = await this.listAll();
    const afterTs = params.statusTimestampAfter ? Date.parse(params.statusTimestampAfter) : NaN;
    const matched: Task[] = [];

    for (const id of ids) {
      let task: Task | undefined;
      try {
        task = await this.load(id);
      } catch {
        continue; // unreadable/corrupt entry \u2014 skip rather than fail the whole page
      }
      if (!task) continue;
      if (params.contextId && task.contextId !== params.contextId) continue;
      if (
        params.status !== TaskState.TASK_STATE_UNSPECIFIED &&
        task.status?.state !== params.status
      ) {
        continue;
      }
      if (!Number.isNaN(afterTs)) {
        const ts = task.status?.timestamp ? Date.parse(task.status.timestamp) : NaN;
        if (Number.isNaN(ts) || ts < afterTs) continue;
      }
      matched.push(projectTask(task, params));
    }

    const pageSize =
      params.pageSize && params.pageSize > 0 ? Math.min(Math.floor(params.pageSize), 100) : 50;
    let offset = 0;
    if (params.pageToken) {
      const parsed = Number.parseInt(params.pageToken, 10);
      if (Number.isInteger(parsed) && parsed > 0) offset = parsed;
    }

    const tasks = matched.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    return {
      tasks,
      nextPageToken: nextOffset < matched.length ? String(nextOffset) : "",
      pageSize,
      totalSize: matched.length,
    };
  }

  /** List all stored task IDs. */
  async listAll(): Promise<string[]> {
    try {
      const entries = await readdir(this.tasksDir);
      return entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => decodeURIComponent(name.slice(0, -5)));
    } catch (error: unknown) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /** Delete a task file and report whether anything was removed. */
  async delete(taskId: string): Promise<boolean> {
    try {
      await unlink(this.taskPath(taskId));
      return true;
    } catch (error: unknown) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private taskPath(taskId: string): string {
    return path.join(this.tasksDir, taskFileName(taskId));
  }

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = mkdir(this.tasksDir, { recursive: true }).then(
        () => {},
        (error) => {
          this.dirReady = null;
          throw error;
        },
      );
    }
    return this.dirReady;
  }
}
