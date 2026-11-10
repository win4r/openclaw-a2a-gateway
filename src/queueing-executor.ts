import { v4 as uuidv4 } from "uuid";

import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task, TaskStatus } from "@a2a-js/sdk";
import type {
  AgentExecutionEvent,
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";

import { taskStateName, textPart, v1Message } from "./types-v1.js";

import { GatewayTelemetry } from "./telemetry.js";
import { computeSaturationDelay, type SaturationConfig } from "./saturation-model.js";

interface QueueingExecutorOptions {
  maxConcurrentTasks: number;
  maxQueuedTasks: number;
  /** Bio-inspired Michaelis-Menten soft concurrency config. */
  saturation?: SaturationConfig;
}

interface QueuedTaskEntry {
  requestContext: RequestContext;
  eventBus: ExecutionEventBus;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Terminal task states that end a queued run (v1 enum values). */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

function statusMessage(contextId: string, taskId: string, text: string): Message {
  return v1Message({
    messageId: uuidv4(),
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    contextId,
    taskId,
  });
}

/** Build a wrapped v1 task lifecycle event for the execution event bus. */
function taskEvent(
  taskId: string,
  contextId: string,
  state: TaskState,
  text?: string,
): AgentExecutionEvent {
  const task: Task = {
    id: taskId,
    contextId,
    status: {
      state,
      message: text ? statusMessage(contextId, taskId, text) : undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
  return { kind: "task", data: task };
}

type BusListener = ((event: AgentExecutionEvent) => void) | (() => void);

/** Map a v1 TaskState onto the telemetry wire name for finished tasks. */
function terminalWire(
  state: TaskState,
): "completed" | "failed" | "canceled" | "rejected" {
  if (state === TaskState.TASK_STATE_COMPLETED) return "completed";
  if (state === TaskState.TASK_STATE_CANCELED) return "canceled";
  if (state === TaskState.TASK_STATE_REJECTED) return "rejected";
  return "failed";
}

function createObservedEventBus(
  eventBus: ExecutionEventBus,
  observer: (event: AgentExecutionEvent) => void,
): ExecutionEventBus {
  const wrapped: ExecutionEventBus = {
    publish(event) {
      observer(event);
      eventBus.publish(event);
    },
    on(eventName: "event" | "finished", listener: BusListener): ExecutionEventBus {
      // Forward verbatim; the target bus owns the overload dispatch.
      (eventBus.on as (name: "event", listener: unknown) => unknown)(
        eventName as "event",
        listener,
      );
      return wrapped;
    },
    off(eventName: "event" | "finished", listener: BusListener): ExecutionEventBus {
      (eventBus.off as (name: "event", listener: unknown) => unknown)(
        eventName as "event",
        listener,
      );
      return wrapped;
    },
    once(eventName: "event" | "finished", listener: BusListener): ExecutionEventBus {
      (eventBus.once as (name: "event", listener: unknown) => unknown)(
        eventName as "event",
        listener,
      );
      return wrapped;
    },
    removeAllListeners(eventName?: "event" | "finished"): ExecutionEventBus {
      eventBus.removeAllListeners(eventName);
      return wrapped;
    },
    finished() {
      eventBus.finished();
    },
  };

  return wrapped;
}

export class QueueingAgentExecutor implements AgentExecutor {
  private readonly delegate: AgentExecutor;
  private readonly telemetry: GatewayTelemetry;
  private readonly options: QueueingExecutorOptions;
  private readonly defaultAgentId: string;
  private readonly queue: QueuedTaskEntry[] = [];
  private readonly pendingByTaskId = new Map<string, QueuedTaskEntry>();
  private activeTasks = 0;

  constructor(delegate: AgentExecutor, telemetry: GatewayTelemetry, options: QueueingExecutorOptions, defaultAgentId = "main") {
    this.delegate = delegate;
    this.telemetry = telemetry;
    this.defaultAgentId = defaultAgentId;
    this.options = {
      maxConcurrentTasks: Math.max(1, options.maxConcurrentTasks),
      maxQueuedTasks: Math.max(0, options.maxQueuedTasks),
    };
  }

  /** Release resources owned by delegates that expose an explicit close hook. */
  close(): void {
    const delegate = this.delegate as AgentExecutor & { close?: () => void };
    delegate.close?.();
  }

  execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueuedTaskEntry = {
        requestContext,
        eventBus,
        resolve,
        reject,
      };

      this.pendingByTaskId.set(requestContext.taskId, entry);

      if (this.activeTasks < this.options.maxConcurrentTasks) {
        void this.runEntry(entry);
        return;
      }

      if (this.queue.length >= this.options.maxQueuedTasks) {
        this.pendingByTaskId.delete(requestContext.taskId);
        this.telemetry.recordQueueRejected(
          requestContext.taskId,
          requestContext.contextId,
          this.queue.length,
        );
        eventBus.publish(
          taskEvent(
            requestContext.taskId,
            requestContext.contextId,
            TaskState.TASK_STATE_REJECTED,
            "Gateway is overloaded; queue limit reached",
          ),
        );
        eventBus.finished();
        resolve();
        return;
      }

      this.queue.push(entry);
      this.telemetry.recordTaskQueued(
        requestContext.taskId,
        requestContext.contextId,
        this.queue.length,
        this.queue.length,
      );
      eventBus.publish(
        taskEvent(
          requestContext.taskId,
          requestContext.contextId,
          TaskState.TASK_STATE_SUBMITTED,
          `Queued for execution (position ${this.queue.length})`,
        ),
      );
    });
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const queuedIndex = this.queue.findIndex((entry) => entry.requestContext.taskId === taskId);
    if (queuedIndex !== -1) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      if (entry) {
        this.pendingByTaskId.delete(taskId);
        entry.eventBus.publish(
          taskEvent(
            taskId,
            entry.requestContext.contextId,
            TaskState.TASK_STATE_CANCELED,
            "Task canceled while queued",
          ),
        );
        entry.eventBus.finished();
        entry.resolve();
        this.telemetry.recordTaskFinish(
          taskId,
          entry.requestContext.contextId,
          terminalWire(TaskState.TASK_STATE_CANCELED),
          0,
          this.activeTasks,
          this.queue.length,
        );
      }
      return;
    }

    await this.delegate.cancelTask(taskId, eventBus);
  }

  private async runEntry(entry: QueuedTaskEntry): Promise<void> {
    const { requestContext } = entry;
    const startedAt = Date.now();
    let finalState: TaskState | undefined;
    let finalErrorMessage: string | undefined;

    this.queueDelete(requestContext.taskId);

    // Bio-inspired Michaelis-Menten soft concurrency: add progressive delay
    // under load instead of hard rejection (enzyme kinetics analogy).
    if (this.options.saturation) {
      const delayMs = computeSaturationDelay(
        this.activeTasks,
        this.options.maxConcurrentTasks,
        this.options.saturation,
      );
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    this.activeTasks += 1;
    this.telemetry.recordTaskStart(
      requestContext.taskId,
      requestContext.contextId,
      this.pickAgentId(requestContext),
      this.activeTasks,
      this.queue.length,
    );

    const observedBus = createObservedEventBus(entry.eventBus, (event) => {
      const data = event.data as Partial<Task> | undefined;
      const status: TaskStatus | undefined =
        event.kind === "task" || event.kind === "statusUpdate" ? (data?.status ?? undefined) : undefined;
      if (!status) {
        return;
      }
      if (TERMINAL_STATES.has(status.state)) {
        finalState = status.state;
        if (status.state !== TaskState.TASK_STATE_COMPLETED) {
          const firstPart = status.message?.parts?.[0];
          if (firstPart?.content?.$case === "text") {
            finalErrorMessage = firstPart.content.value;
          }
        }
      }
    });

    try {
      await this.delegate.execute(requestContext, observedBus);
      entry.resolve();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      finalState = finalState ?? TaskState.TASK_STATE_FAILED;
      finalErrorMessage = finalErrorMessage || message;
      entry.reject(error instanceof Error ? error : new Error(message));
      return;
    } finally {
      this.pendingByTaskId.delete(requestContext.taskId);
      this.activeTasks = Math.max(0, this.activeTasks - 1);

      this.telemetry.recordTaskFinish(
        requestContext.taskId,
        requestContext.contextId,
        terminalWire(finalState ?? TaskState.TASK_STATE_FAILED),
        Date.now() - startedAt,
        this.activeTasks,
        this.queue.length,
        finalErrorMessage,
      );

      // Ensure eventBus.finished() is always called so the SDK's
      // DefaultRequestHandler does not hang waiting for the signal.
      try {
        entry.eventBus.finished();
      } catch {
        // already finished — safe to ignore
      }

      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this.activeTasks < this.options.maxConcurrentTasks && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      void this.runEntry(next);
    }
  }

  private queueDelete(taskId: string): void {
    const index = this.queue.findIndex((entry) => entry.requestContext.taskId === taskId);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  private pickAgentId(requestContext: RequestContext): string {
    const message = requestContext.userMessage as unknown as Record<string, unknown> | undefined;
    return typeof message?.agentId === "string" ? message.agentId : this.defaultAgentId;
  }
}
