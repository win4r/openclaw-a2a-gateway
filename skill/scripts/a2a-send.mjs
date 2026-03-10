#!/usr/bin/env node
/**
 * Send a message to an A2A peer using the official @a2a-js/sdk.
 *
 * Usage:
 *   node a2a-send.mjs --peer-url <PEER_BASE_URL> --token <TOKEN> --message "Hello!"
 *   node a2a-send.mjs --peer-url http://100.76.43.74:18800 --token abc123 --message "What is your name?"
 *   node a2a-send.mjs --peer-url <URL> --token <TOKEN> --message "Follow up" --task-id <TASK_ID> --context-id <CONTEXT_ID>
 *
 * Async task mode (recommended for long-running prompts):
 *   node a2a-send.mjs --peer-url <URL> --token <TOKEN> --non-blocking --wait --message "..."
 *
 * Options:
 *   --peer-url <url>        Peer base URL, e.g. http://100.76.43.74:18800
 *   --token <token>         Bearer token for the peer inbound auth
 *   --message <text>        Text to send
 *   --task-id <id>          Reuse an existing A2A task for follow-up turns
 *   --context-id <id>       Reuse an existing A2A context for multi-round conversation routing
 *   --non-blocking          Send with configuration.blocking=false (returns quickly with a Task)
 *   --wait                  When non-blocking, poll tasks/get until terminal state
 *   --timeout-ms <ms>       Max wait time for --wait (default: 600000)
 *   --poll-ms <ms>          Poll interval for --wait (default: 1000)
 *   --help                  Show this help text
 *
 * Optional (OpenClaw extension):
 *   --agent-id <agentId>    Route the inbound A2A request to a specific OpenClaw agentId on the peer.
 *                           Note: this works reliably over JSON-RPC/REST. gRPC transport may drop unknown
 *                           Message fields, so gRPC is disabled when --agent-id is used.
 *
 * Requires: npm install @a2a-js/sdk
 */

import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const USAGE = `Usage: node a2a-send.mjs --peer-url <URL> --token <TOKEN> --message <TEXT> [--file-uri <url>] [--file-path <localpath>] [--task-id <id>] [--context-id <id>] [--non-blocking] [--wait] [--timeout-ms <ms>] [--poll-ms <ms>] [--agent-id <openclaw-agent-id>] [--help]`;

const MAX_INLINE_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const CLI_MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".webm": "video/webm", ".zip": "application/zip",
};

const CLI_ALLOWED_MIME_PATTERNS = [
  "image/*", "application/pdf", "text/plain", "text/csv",
  "application/json", "audio/*", "video/*",
];

function detectMimeFromPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  return CLI_MIME_MAP[ext] || "application/octet-stream";
}

function isMimeAllowed(mimeType) {
  const normalized = mimeType.toLowerCase();
  for (const pattern of CLI_ALLOWED_MIME_PATTERNS) {
    if (normalized === pattern) return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (normalized.startsWith(prefix)) return true;
    }
  }
  return false;
}

function usageAndExit(code = 1) {
  const stream = code === 0 ? console.log : console.error;
  stream(USAGE);
  process.exit(code);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;

    const key = arg.replace(/^--/, "");
    const next = args[i + 1];

    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }

  if (opts.help || opts.h) {
    usageAndExit(0);
  }

  const peerUrl = String(opts["peer-url"] || opts.peerUrl || "").trim();
  const message = String(opts.message || "").trim();
  const fileUri = String(opts["file-uri"] || opts.fileUri || "").trim();
  const filePath = String(opts["file-path"] || opts.filePath || "").trim();

  // At least one of --message, --file-uri, --file-path required
  if (!peerUrl || (!message && !fileUri && !filePath)) {
    usageAndExit(1);
  }

  return { ...opts, peerUrl, message, fileUri, filePath };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstTextParts(parts) {
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) {
    if (p && typeof p === "object" && p.kind === "text" && typeof p.text === "string") {
      return p.text;
    }
  }
  return undefined;
}

async function main() {
  const opts = parseArgs();

  const peerUrl = opts.peerUrl;
  const token = typeof opts.token === "string" ? opts.token : "";
  const message = opts.message;
  const targetAgentId = (opts["agent-id"] || opts.agentId || "").toString().trim();
  const continuationTaskId = (opts["task-id"] || opts.taskId || "").toString().trim().slice(0, 256);
  const continuationContextId = (opts["context-id"] || opts.contextId || "").toString().trim().slice(0, 256);

  const nonBlocking = Boolean(opts["non-blocking"] || opts.nonBlocking);
  const wait = Boolean(opts.wait);

  const timeoutMsRaw = opts["timeout-ms"] || opts.timeoutMs;
  const pollMsRaw = opts["poll-ms"] || opts.pollMs;

  // Default wait timeout: 10 minutes. Long agent runs are common in multi-round discussions.
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 600_000;
  const pollMs = pollMsRaw ? Number(pollMsRaw) : 1_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("Invalid --timeout-ms");
    usageAndExit(2);
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    console.error("Invalid --poll-ms");
    usageAndExit(2);
  }

  // Build auth handler
  const authHandler = token
    ? {
        headers: async () => ({ authorization: `Bearer ${token}` }),
        shouldRetryWithHeaders: async () => undefined,
      }
    : undefined;

  const authFetch = authHandler
    ? createAuthenticatingFetchWithRetry(fetch, authHandler)
    : fetch;

  // If using OpenClaw extension agentId routing, disable gRPC transport to avoid
  // protobuf dropping unknown message fields.
  const transports = targetAgentId
    ? [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
      ]
    : [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ];

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports,
    })
  );

  // Discover agent card and create client
  const client = await factory.createFromUrl(peerUrl);

  // Build message parts: text + optional file
  const outboundParts = [];
  if (message) {
    outboundParts.push({ kind: "text", text: message });
  }

  const fileUri = opts.fileUri;
  const filePath = opts.filePath;

  if (filePath) {
    // Read local file, base64-encode, auto-detect MIME
    const stat = statSync(filePath);
    if (stat.size > MAX_INLINE_FILE_SIZE) {
      console.error(`File too large: ${(stat.size / 1048576).toFixed(1)}MB exceeds 10MB limit`);
      process.exit(2);
    }
    const mimeType = detectMimeFromPath(filePath);
    if (!isMimeAllowed(mimeType)) {
      console.error(`MIME type not allowed: ${mimeType}`);
      process.exit(2);
    }
    const fileBuffer = readFileSync(filePath);
    const base64 = fileBuffer.toString("base64");
    const name = filePath.split("/").pop() || "file";
    outboundParts.push({
      kind: "file",
      file: { bytes: base64, mimeType, name },
    });
  } else if (fileUri) {
    // URI-based file reference
    outboundParts.push({
      kind: "file",
      file: { uri: fileUri },
    });
  }

  if (outboundParts.length === 0) {
    console.error("No message content to send");
    process.exit(2);
  }

  const outboundMessage = {
    kind: "message",
    messageId: randomUUID(),
    role: "user",
    parts: outboundParts,
    ...(continuationTaskId ? { taskId: continuationTaskId } : {}),
    ...(continuationContextId ? { contextId: continuationContextId } : {}),
    ...(targetAgentId ? { agentId: targetAgentId } : {}),
  };

  const requestOptions = token ? { serviceParameters: { authorization: `Bearer ${token}` } } : undefined;

  const sendParams = {
    message: outboundMessage,
    ...(nonBlocking ? { configuration: { blocking: false } } : {}),
  };

  const result = await client.sendMessage(sendParams, requestOptions);

  const printTaskHandle = (task) => {
    if (!task || typeof task !== "object") return;
    const responseTaskId = typeof task.id === "string" ? task.id : typeof task.taskId === "string" ? task.taskId : "";
    if (!responseTaskId) return;
    const responseContextId =
      typeof task.contextId === "string"
        ? task.contextId
        : typeof continuationContextId === "string" && continuationContextId
          ? continuationContextId
          : "";
    console.log(`[task] id=${responseTaskId} contextId=${responseContextId || "-"}`);
  };

  // If the user didn't request waiting, print the immediate response.
  if (!nonBlocking || !wait) {
    if (result?.kind === "message") {
      const text = extractFirstTextParts(result.parts);
      console.log(text || JSON.stringify(result, null, 2));
      return;
    }
    if (result?.kind === "task") {
      printTaskHandle(result);
      const text = extractFirstTextParts(result.status?.message?.parts);
      console.log(text || JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Async task mode: wait for terminal task state via tasks/get.
  const responseTaskId = result?.kind === "task" ? result.id : result?.taskId;
  if (!responseTaskId || typeof responseTaskId !== "string") {
    // Can't wait if we don't know the task id.
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result?.kind === "task") {
    printTaskHandle(result);
  }

  const startedAt = Date.now();
  const terminalStates = new Set(["completed", "failed", "canceled"]);

  while (true) {
    const task = await client.getTask({ id: responseTaskId, historyLength: 20 }, requestOptions);
    const state = task?.status?.state;

    if (state && terminalStates.has(state)) {
      const text = extractFirstTextParts(task.status?.message?.parts);
      console.log(text || JSON.stringify(task, null, 2));
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      console.error(`Timeout waiting for task ${responseTaskId} after ${timeoutMs}ms`);
      console.log(JSON.stringify(task, null, 2));
      process.exit(3);
    }

    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error("Error:", err?.stack || err?.message || String(err));
  process.exit(1);
});
