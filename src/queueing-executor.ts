import { v4 as uuidv4 } from "uuid";

import type { Message, Task } from "@a2a-js/sdk";
import type {
  AgentExecutionEvent,
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";

import { GatewayTelemetry } from "./telemetry.js";

interface QueueingExecutorOptions {
  maxConcurrentTasks: number;
  maxQueuedTasks: number;
}

interface QueuedTaskEntry {
  requestContext: RequestContext;
  eventBus: ExecutionEventBus;
  resolve: () => void;
  reject: (error: Error) => void;
}

type TerminalTaskState = "completed" | "failed" | "canceled" | "rejected";

function statusMessage(contextId: string, text: string): Message {
  return {
    kind: "message",
    messageId: uuidv4(),
    role: "agent",
    contextId,
    parts: [{ kind: "text", text }],
  };
}

function taskEvent(
  taskId: string,
  contextId: string,
  state: Task["status"]["state"],
  text?: string,
): Task {
  return {
    kind: "task",
    id: taskId,
    contextId,
    status: {
      state,
      message: text ? statusMessage(contextId, text) : undefined,
      timestamp: new Date().toISOString(),
    },
  };
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
    on(eventName, listener) {
      eventBus.on(eventName, listener);
      return wrapped;
    },
    off(eventName, listener) {
      eventBus.off(eventName, listener);
      return wrapped;
    },
    once(eventName, listener) {
      eventBus.once(eventName, listener);
      return wrapped;
    },
    removeAllListeners(eventName) {
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
  private readonly queue: QueuedTaskEntry[] = [];
  private readonly pendingByTaskId = new Map<string, QueuedTaskEntry>();
  private activeTasks = 0;

  constructor(delegate: AgentExecutor, telemetry: GatewayTelemetry, options: QueueingExecutorOptions) {
    this.delegate = delegate;
    this.telemetry = telemetry;
    this.options = {
      maxConcurrentTasks: Math.max(1, options.maxConcurrentTasks),
      maxQueuedTasks: Math.max(0, options.maxQueuedTasks),
    };
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
            "rejected",
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
          "submitted",
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
          taskEvent(taskId, entry.requestContext.contextId, "canceled", "Task canceled while queued"),
        );
        entry.eventBus.finished();
        entry.resolve();
        this.telemetry.recordTaskFinish(
          taskId,
          entry.requestContext.contextId,
          "canceled",
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
    let finalState: TerminalTaskState | undefined;
    let finalErrorMessage: string | undefined;

    this.queueDelete(requestContext.taskId);
    this.activeTasks += 1;
    this.telemetry.recordTaskStart(
      requestContext.taskId,
      requestContext.contextId,
      this.pickAgentId(requestContext),
      this.activeTasks,
      this.queue.length,
    );

    const observedBus = createObservedEventBus(entry.eventBus, (event) => {
      const status = event.kind === "task" || event.kind === "status-update" ? event.status : undefined;
      if (!status) {
        return;
      }
      if (
        status.state === "completed" ||
        status.state === "failed" ||
        status.state === "canceled" ||
        status.state === "rejected"
      ) {
        finalState = status.state;
        if (status.state !== "completed") {
          finalErrorMessage =
            typeof status.message?.parts?.[0] === "object" && status.message.parts[0]?.kind === "text"
              ? status.message.parts[0].text
              : finalErrorMessage;
        }
      }
    });

    try {
      await this.delegate.execute(requestContext, observedBus);
      entry.resolve();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      finalState = finalState || "failed";
      finalErrorMessage = finalErrorMessage || message;
      entry.reject(error instanceof Error ? error : new Error(message));
      return;
    } finally {
      this.pendingByTaskId.delete(requestContext.taskId);
      this.activeTasks = Math.max(0, this.activeTasks - 1);

      this.telemetry.recordTaskFinish(
        requestContext.taskId,
        requestContext.contextId,
        finalState || "failed",
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
    return typeof message?.agentId === "string" ? message.agentId : "default";
  }
}
