#!/usr/bin/env node
/**
 * Send a message to an A2A peer using the official @a2a-js/sdk.
 *
 * Usage:
 *   node a2a-send.mjs --peer AntiBot --message "Hello!"
 *   node a2a-send.mjs --peer-url http://100.76.43.74:18800 --token abc123 --message "What is your name?"
 *   node a2a-send.mjs --peer AntiBot --message "Follow up" --task-id <TASK_ID> --context-id <CONTEXT_ID>
 *
 * Async task mode (recommended for long-running prompts):
 *   node a2a-send.mjs --peer AntiBot --non-blocking --wait --message "..."
 *
 * Options:
 *   --peer <name>           Peer alias from ~/.openclaw/a2a-peers.json
 *   --peer-url <url>        Peer base URL, e.g. http://100.76.43.74:18800 (env: A2A_PEER_URL)
 *   --token <token>         Bearer token for the peer inbound auth (env: A2A_TOKEN)
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
import { resolveConnection } from "./a2a-peers.mjs";

const USAGE = `Usage: node a2a-send.mjs [--peer <name> | --peer-url <URL>] --message <TEXT> [--file-uri <url>] [--file-path <localpath>] [--task-id <id>] [--context-id <id>] [--non-blocking] [--wait] [--stream] [--timeout-ms <ms>] [--poll-ms <ms>] [--agent-id <openclaw-agent-id>] [--help]`;

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

  const peerUrl = String(opts["peer-url"] || opts.peerUrl || process.env.A2A_PEER_URL || "").trim();
  const message = String(opts.message || "").trim();
  const fileUri = String(opts["file-uri"] || opts.fileUri || "").trim();
  const filePath = String(opts["file-path"] || opts.filePath || "").trim();

  // Need a peer target (--peer-url, --peer alias, or A2A_PEER_URL) and at least one payload
  if ((!peerUrl && !opts.peer) || (!message && !fileUri && !filePath)) {
    usageAndExit(1);
  }

  return { ...opts, peerUrl, message, fileUri, filePath };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "EPIPE"]);

function isRetryableError(err) {
  const code = err?.cause?.code || err?.code || "";
  if (RETRYABLE_CODES.has(code)) return true;
  const msg = err?.message || "";
  return RETRYABLE_CODES.has(msg) || msg.includes("fetch failed") || msg.includes("ECONNREFUSED");
}

async function retryOnConnectionError(fn, { maxRetries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.error(`Connection failed (${err?.cause?.code || err?.message}), retrying in ${(delay / 1000).toFixed(0)}s... (${attempt + 1}/${maxRetries})`);
      await sleep(delay);
    }
  }
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

  const { url: peerUrl, token } = resolveConnection(opts);
  const message = opts.message;
  const targetAgentId = (opts["agent-id"] || opts.agentId || "").toString().trim();
  const continuationTaskId = (opts["task-id"] || opts.taskId || "").toString().trim().slice(0, 256);
  const continuationContextId = (opts["context-id"] || opts.contextId || "").toString().trim().slice(0, 256);

  const nonBlocking = Boolean(opts["non-blocking"] || opts.nonBlocking);
  const wait = Boolean(opts.wait);
  const stream = Boolean(opts.stream);

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

  // Discover agent card and create client (with retry for transient network errors)
  const client = await retryOnConnectionError(() => factory.createFromUrl(peerUrl));

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

  // SSE streaming mode: subscribe to task event stream
  if (stream) {
    console.log("[stream] connecting...");
    // Note: stream mode does not auto-retry — connection errors surface immediately.
    // Retrying a partially-consumed stream has different semantics than retrying a single RPC.
    const eventStream = client.sendMessageStream(sendParams, requestOptions);
    for await (const event of eventStream) {
      const kind = event?.kind;
      if (kind === "task") {
        const state = event.status?.state;
        const text = extractFirstTextParts(event.status?.message?.parts);
        if (state === "working") {
          console.log(`[stream] working... (${event.status?.timestamp || ""})`);
        } else if (text) {
          console.log(`[stream] ${state}: ${text}`);
        } else {
          console.log(`[stream] ${state}: ${JSON.stringify(event.status)}`);
        }
      } else if (kind === "status-update") {
        const state = event.status?.state;
        const text = extractFirstTextParts(event.status?.message?.parts);
        console.log(`[stream] status-update: ${state}${text ? ` — ${text}` : ""}`);
      } else {
        console.log(`[stream] ${kind || "unknown"}: ${JSON.stringify(event)}`);
      }
    }
    console.log("[stream] done");
    return;
  }

  const result = await retryOnConnectionError(() => client.sendMessage(sendParams, requestOptions));

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
  const terminalStates = new Set(["completed", "failed", "canceled", "rejected"]);
  const blockedStates = new Set(["input-required", "auth-required"]);

  while (true) {
    const task = await client.getTask({ id: responseTaskId, historyLength: 20 }, requestOptions);
    const state = task?.status?.state;

    if (state && terminalStates.has(state)) {
      const text = extractFirstTextParts(task.status?.message?.parts);
      console.log(text || JSON.stringify(task, null, 2));
      return;
    }

    if (state && blockedStates.has(state)) {
      console.error(`\nTask is blocked (${state}). It needs external action to proceed.`);
      console.error(`Check status later: node a2a-status.mjs --task-id ${responseTaskId}`);
      console.log(JSON.stringify(task, null, 2));
      process.exit(2);
    }

    if (Date.now() - startedAt > timeoutMs) {
      const elapsed = (timeoutMs / 1000).toFixed(0);
      const lastState = task?.status?.state || "unknown";
      console.error(`\nTimeout: task ${responseTaskId} still "${lastState}" after ${elapsed}s`);
      console.error(`Tip: increase --timeout-ms or check status later with:`);
      console.error(`  node a2a-status.mjs --task-id ${responseTaskId} --wait`);
      console.log(JSON.stringify(task, null, 2));
      process.exit(3);
    }

    await sleep(pollMs);
  }
}

main().catch((err) => {
  const msg = err?.message || String(err);
  const code = err?.cause?.code || err?.code || "";

  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    console.error(`Connection refused — peer is not reachable.`);
    console.error(`  1. Check if the peer is running: curl -s <peer-url>/.well-known/agent-card.json`);
    console.error(`  2. Verify the URL: --peer-url or A2A_PEER_URL`);
    console.error(`  3. Check network/firewall (Tailscale connected?)`);
    process.exit(1);
  }

  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || msg.includes("ETIMEDOUT")) {
    console.error(`Connection timed out — peer is not responding.`);
    console.error(`  Network path may be blocked or peer is overloaded.`);
    process.exit(1);
  }

  if (code === "ENOTFOUND" || msg.includes("ENOTFOUND")) {
    console.error(`DNS lookup failed — hostname not found.`);
    console.error(`  Check the peer URL for typos (--peer-url or A2A_PEER_URL).`);
    process.exit(1);
  }

  if (msg.includes("401") || msg.includes("Unauthorized")) {
    console.error(`Authentication failed (401) — token is invalid or expired.`);
    console.error(`  Update --token or A2A_TOKEN env var.`);
    process.exit(1);
  }

  console.error("Error:", err?.stack || msg);
  process.exit(1);
});
