#!/usr/bin/env node
/**
 * Query the status of an A2A task by its task ID.
 *
 * Usage:
 *   node a2a-status.mjs --peer AntiBot --task-id <TASK_ID>
 *   node a2a-status.mjs --task-id <TASK_ID> --wait
 *   node a2a-status.mjs --peer-url <URL> --token <TOKEN> --task-id <TASK_ID> --wait --timeout-ms 30000
 *
 * Options:
 *   --peer <name>           Peer alias from ~/.openclaw/a2a-peers.json
 *   --peer-url <url>        Peer base URL (env: A2A_PEER_URL)
 *   --token <token>         Bearer token (env: A2A_TOKEN)
 *   --task-id <id>          Task ID to query (required)
 *   --wait                  Poll until terminal state (completed/failed/canceled)
 *   --timeout-ms <ms>       Max wait time (default: 600000)
 *   --poll-ms <ms>          Poll interval (default: 2000)
 *   --json                  Output raw JSON instead of formatted text
 *   --help                  Show this help text
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
import { resolveConnection } from "./a2a-peers.mjs";

const USAGE = `Usage: node a2a-status.mjs --task-id <TASK_ID> [--peer <name> | --peer-url <URL>] [--token <TOKEN>] [--wait] [--timeout-ms <ms>] [--poll-ms <ms>] [--json] [--help]`;

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
  if (opts.help || opts.h) usageAndExit(0);
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(parts) {
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) {
    if (p?.kind === "text" && typeof p.text === "string") return p.text;
  }
  return undefined;
}

const STATE_LABELS = {
  submitted: "⏳ submitted (queued)",
  working:   "⚙️  working",
  completed: "✅ completed",
  failed:    "❌ failed",
  canceled:  "🚫 canceled",
  rejected:  "🚫 rejected",
};

function formatTask(task) {
  const state = task?.status?.state || "unknown";
  const label = STATE_LABELS[state] || state;
  const text = extractText(task?.status?.message?.parts);
  const ts = task?.status?.timestamp || "";

  let out = `[${label}] task=${task.id}`;
  if (task.contextId) out += ` context=${task.contextId}`;
  if (ts) out += ` (${ts})`;
  if (text) out += `\n${text}`;
  return out;
}

async function main() {
  const opts = parseArgs();

  const { url: peerUrl, token } = resolveConnection(opts);
  const taskId = String(opts["task-id"] || opts.taskId || "").trim();
  const wait = Boolean(opts.wait);
  const json = Boolean(opts.json);

  const timeoutMs = Number(opts["timeout-ms"] || opts.timeoutMs) || 600_000;
  const pollMs = Number(opts["poll-ms"] || opts.pollMs) || 2_000;

  if (!peerUrl) {
    console.error("Error: --peer-url is required (or set A2A_PEER_URL env var)");
    usageAndExit(1);
  }
  if (!taskId) {
    console.error("Error: --task-id is required");
    usageAndExit(1);
  }

  // Build client
  const authHandler = token
    ? {
        headers: async () => ({ authorization: `Bearer ${token}` }),
        shouldRetryWithHeaders: async () => undefined,
      }
    : undefined;

  const authFetch = authHandler
    ? createAuthenticatingFetchWithRetry(fetch, authHandler)
    : fetch;

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ],
    })
  );

  const client = await factory.createFromUrl(peerUrl);
  const requestOptions = token ? { serviceParameters: { authorization: `Bearer ${token}` } } : undefined;
  const terminalStates = new Set(["completed", "failed", "canceled", "rejected"]);
  const blockedStates = new Set(["input-required", "auth-required"]);

  // Single query mode
  if (!wait) {
    const task = await client.getTask({ id: taskId, historyLength: 20 }, requestOptions);
    if (json) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log(formatTask(task));
    }
    return;
  }

  // Polling mode
  const startedAt = Date.now();
  let lastState = "";

  while (true) {
    const task = await client.getTask({ id: taskId, historyLength: 20 }, requestOptions);
    const state = task?.status?.state;

    // Print state transitions
    if (state !== lastState) {
      if (json) {
        console.log(JSON.stringify({ state, timestamp: task?.status?.timestamp }));
      } else {
        console.log(formatTask(task));
      }
      lastState = state;
    }

    if (state && terminalStates.has(state)) return;

    if (state && blockedStates.has(state)) {
      console.error(`\nTask is blocked (${state}). It needs external action to proceed.`);
      process.exit(2);
    }

    if (Date.now() - startedAt > timeoutMs) {
      console.error(`\nTimeout: task ${taskId} still in "${state}" state after ${(timeoutMs / 1000).toFixed(0)}s`);
      console.error(`Tip: re-run with a longer --timeout-ms, or query again later without --wait`);
      process.exit(3);
    }

    await sleep(pollMs);
  }
}

main().catch((err) => {
  const msg = err?.message || String(err);

  if (err?.cause?.code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    console.error(`Connection refused — is the peer online?`);
    console.error(`  Check: curl -s <peer-url>/.well-known/agent-card.json`);
    process.exit(1);
  }

  console.error("Error:", msg);
  process.exit(1);
});
