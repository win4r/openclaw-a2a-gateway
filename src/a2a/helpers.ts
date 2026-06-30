import { v4 as uuidv4 } from "uuid";

import type { Artifact, Message, Part, Task, TaskStatus } from "@a2a-js/sdk";
import { Role, TaskState, taskStateFromJSON } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";

export const STREAM_RESPONSE_ARTIFACT_ID = "agent-response-text";

export const TERMINAL_TASK_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "",
  };
}

export function urlPart(url: string, mediaType = ""): Part {
  return {
    content: { $case: "url", value: url },
    metadata: undefined,
    filename: "",
    mediaType,
  };
}

export function emptyPart(): Part {
  return textPart("");
}

export function partText(part: Part | undefined): string | undefined {
  if (part?.content?.$case === "text") {
    return part.content.value;
  }
  return undefined;
}

export function agentMessage(contextId: string, parts: Part[], taskId = ""): Message {
  return {
    messageId: uuidv4(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function taskStatus(state: TaskState, message?: Message): TaskStatus {
  return {
    state,
    message: message ?? undefined,
    timestamp: new Date().toISOString(),
  };
}

export function buildTask(
  id: string,
  contextId: string,
  state: TaskState,
  options?: { statusMessage?: Message; history?: Message[]; artifacts?: Artifact[] },
): Task {
  return {
    id,
    contextId,
    status: taskStatus(state, options?.statusMessage),
    artifacts: options?.artifacts ?? [],
    history: options?.history ?? [],
    metadata: undefined,
  };
}

export function textArtifact(artifactId: string, text: string, name = ""): Artifact {
  return {
    artifactId,
    name,
    description: "",
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
  };
}

export function publishTask(eventBus: ExecutionEventBus, task: Task): void {
  eventBus.publish(AgentEvent.task(task));
}

export function publishTextArtifactChunk(
  eventBus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  delta: string,
  append: boolean,
  lastChunk = false,
): void {
  if (!delta) {
    return;
  }

  eventBus.publish(
    AgentEvent.artifactUpdate({
      taskId,
      contextId,
      append,
      lastChunk,
      artifact: textArtifact(STREAM_RESPONSE_ARTIFACT_ID, delta, "agent-response"),
      metadata: undefined,
    }),
  );
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function normalizeTaskState(state: unknown): TaskState {
  if (typeof state === "number") {
    return state as TaskState;
  }
  if (typeof state === "string") {
    switch (state) {
      case "submitted":
        return TaskState.TASK_STATE_SUBMITTED;
      case "working":
        return TaskState.TASK_STATE_WORKING;
      case "completed":
        return TaskState.TASK_STATE_COMPLETED;
      case "failed":
        return TaskState.TASK_STATE_FAILED;
      case "canceled":
        return TaskState.TASK_STATE_CANCELED;
      case "rejected":
        return TaskState.TASK_STATE_REJECTED;
      case "input-required":
        return TaskState.TASK_STATE_INPUT_REQUIRED;
      case "auth-required":
        return TaskState.TASK_STATE_AUTH_REQUIRED;
      default:
        return taskStateFromJSON(state);
    }
  }
  return TaskState.TASK_STATE_UNSPECIFIED;
}

export function terminalStateLabel(state: TaskState): "completed" | "failed" | "canceled" | "rejected" | undefined {
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    default:
      return undefined;
  }
}
