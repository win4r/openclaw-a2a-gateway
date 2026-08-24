/**
 * Shared builders for A2A v1 (protobuf-flavored) message structures.
 *
 * The v1 wire types are generated from protobuf and every field is
 * explicitly present (`| undefined` instead of optional `?`). These
 * helpers centralize construction so call sites stay readable.
 */
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Part } from "@a2a-js/sdk";

/** Human-readable lowercase wire name for a v1 TaskState enum value. */
export function taskStateName(state: TaskState): string {
  const name = TaskState[state];
  return typeof name === "string" ? name.replace(/^TASK_STATE_/, "").toLowerCase() : "unknown";
}

/** Build a v1 text Part. */
export function textPart(value: string, mediaType = "text/plain"): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType,
  };
}

/** Build a v1 URL-referenced file Part. */
export function urlFilePart(url: string, filename = "", mediaType = "application/octet-stream"): Part {
  return {
    content: { $case: "url", value: url },
    metadata: undefined,
    filename,
    mediaType,
  };
}

/** Build a v1 raw-content file Part (value is raw bytes). */
export function rawFilePart(bytes: Buffer, filename = "", mediaType = "application/octet-stream"): Part {
  return {
    content: { $case: "raw", value: bytes },
    metadata: undefined,
    filename,
    mediaType,
  };
}

/** Build a v1 structured-data Part. */
export function dataPart(data: unknown): Part {
  return {
    content: { $case: "data", value: data },
    metadata: undefined,
    filename: "",
    mediaType: "application/json",
  };
}

export interface V1MessageInit {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** Build a complete v1 Message with protobuf-required fields filled. */
export function v1Message(init: V1MessageInit): Message {
  return {
    messageId: init.messageId,
    contextId: init.contextId ?? "",
    taskId: init.taskId ?? "",
    role: init.role,
    parts: init.parts,
    metadata: (init.metadata as Record<string, any> | undefined) ?? undefined,
    extensions: init.extensions ?? [],
    referenceTaskIds: init.referenceTaskIds ?? [],
  };
}

/**
 * Coerce arbitrary caller-supplied parts (v0.3 TextPart/FilePart/DataPart,
 * plain strings, or already-v1 parts) into v1 Part structures.
 */
export function toV1Part(input: unknown): Part {
  if (input === null || input === undefined) return textPart("");
  if (typeof input !== "object") return textPart(String(input));

  const p = input as Record<string, any>;

  // Already v1 ($case-discriminated content)
  if (p.content && typeof p.content === "object" && "$case" in p.content) {
    return p as Part;
  }
  // v0.3 / shorthand text
  if (typeof p.text === "string" && p.kind !== "file") {
    return textPart(p.text);
  }
  // v0.3 DataPart or bare data payload
  if (p.kind === "data" || ("data" in p && p.data !== undefined)) {
    return dataPart(p.data ?? p.value);
  }
  // v0.3 FilePart { file: { uri | bytes, mimeType?, name? } }
  if (p.file && typeof p.file === "object") {
    const f = p.file;
    if (typeof f.uri === "string") return urlFilePart(f.uri, f.name ?? "", f.mimeType ?? "application/octet-stream");
    if (typeof f.bytes === "string") {
      return rawFilePart(Buffer.from(f.bytes, "base64"), f.name ?? "", f.mimeType ?? "application/octet-stream");
    }
  }
  // v1-style flat fields without wrapper
  if (typeof p.url === "string" && (p.kind === "file" || !("kind" in p))) {
    return urlFilePart(p.url, p.filename ?? "", p.mediaType ?? "application/octet-stream");
  }
  if (Buffer.isBuffer(p.raw)) return rawFilePart(p.raw, p.filename ?? "", p.mediaType ?? "application/octet-stream");
  if (typeof p.raw === "string" && (p.kind === "file" || p.mediaType)) {
    return rawFilePart(Buffer.from(p.raw, "base64"), p.filename ?? "", p.mediaType ?? "application/octet-stream");
  }

  return textPart(JSON.stringify(p));
}

/** Convert an unknown parts array into v1 Parts. */
export function toV1Parts(inputs: unknown): Part[] {
  if (Array.isArray(inputs)) return inputs.map(toV1Part);
  return [toV1Part(inputs)];
}
