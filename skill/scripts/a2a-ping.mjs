#!/usr/bin/env node
/**
 * Check if an A2A peer is online by fetching its Agent Card.
 *
 * Usage:
 *   node a2a-ping.mjs --peer-url <URL>
 *   node a2a-ping.mjs --peer AntiBot               # resolve from ~/.openclaw/a2a-peers.json
 *   node a2a-ping.mjs --all                         # ping all configured peers
 *
 * Options:
 *   --peer-url <url>        Peer base URL (env: A2A_PEER_URL)
 *   --peer <name>           Peer alias from ~/.openclaw/a2a-peers.json
 *   --token <token>         Bearer token (env: A2A_TOKEN)
 *   --all                   Ping all peers in ~/.openclaw/a2a-peers.json
 *   --timeout-ms <ms>       Request timeout (default: 5000)
 *   --help                  Show this help text
 */

import { loadPeers, resolvePeer, resolveConnection, PEERS_FILE } from "./a2a-peers.mjs";

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
  return opts;
}

async function pingPeer(url, token, timeoutMs) {
  const cardUrl = url.replace(/\/+$/, "") + "/.well-known/agent-card.json";
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(cardUrl, { headers, signal: controller.signal });
    const latency = Date.now() - start;

    if (!res.ok) {
      return { online: false, latency, error: `HTTP ${res.status}` };
    }

    const card = await res.json();
    return {
      online: true,
      latency,
      name: card.name || card.agentName || "(unnamed)",
      description: card.description || "",
      version: card.version || "",
    };
  } catch (err) {
    const latency = Date.now() - start;
    if (err.name === "AbortError") {
      return { online: false, latency, error: `timeout (${timeoutMs}ms)` };
    }
    const code = err?.cause?.code || "";
    if (code === "ECONNREFUSED") {
      return { online: false, latency, error: "connection refused" };
    }
    return { online: false, latency, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function formatResult(label, result) {
  if (result.online) {
    const parts = [`\u2705 ${label} — online (${result.latency}ms)`];
    if (result.name) parts[0] += ` — ${result.name}`;
    if (result.version) parts.push(`  version: ${result.version}`);
    return parts.join("\n");
  }
  return `\u274C ${label} — offline (${result.error})`;
}

async function main() {
  const opts = parseArgs();

  if (opts.help || opts.h) {
    console.log(`Usage: node a2a-ping.mjs [--peer-url <URL>] [--peer <name>] [--all] [--timeout-ms <ms>]`);
    process.exit(0);
  }

  const timeoutMs = Number(opts["timeout-ms"] || opts.timeoutMs) || 5000;

  // --all mode: ping every configured peer
  if (opts.all) {
    const peers = loadPeers();
    const names = Object.keys(peers);
    if (names.length === 0) {
      console.error(`No peers configured. Create ${PEERS_FILE} with:`);
      console.error(`  { "AntiBot": { "url": "http://...", "token": "..." } }`);
      process.exit(1);
    }

    const results = await Promise.all(
      names.map(async (name) => {
        const entry = peers[name];
        const url = typeof entry === "string" ? entry : entry.url;
        const token = typeof entry === "object" ? entry.token : undefined;
        const result = await pingPeer(url, token, timeoutMs);
        return { name, result };
      })
    );

    for (const { name, result } of results) {
      console.log(formatResult(name, result));
    }

    const onlineCount = results.filter((r) => r.result.online).length;
    console.log(`\n${onlineCount}/${results.length} peers online`);
    process.exit(onlineCount === results.length ? 0 : 1);
  }

  // Single peer mode
  const { url, token } = resolveConnection(opts);

  if (!url) {
    console.error("Error: --peer-url, --peer <name>, or A2A_PEER_URL required");
    process.exit(1);
  }

  const label = opts.peer || url;
  const result = await pingPeer(url, token, timeoutMs);
  console.log(formatResult(label, result));
  process.exit(result.online ? 0 : 1);
}

main().catch((err) => {
  console.error("Error:", err.message || String(err));
  process.exit(1);
});
