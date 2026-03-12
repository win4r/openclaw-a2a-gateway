import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";

function cloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
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
    await rename(tmpPath, targetPath);
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
