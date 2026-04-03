/**
 * Shared peer alias resolution for A2A CLI scripts.
 *
 * Reads ~/.openclaw/a2a-peers.json to resolve peer names to URLs and tokens.
 *
 * Config format (~/.openclaw/a2a-peers.json):
 *   {
 *     "AntiBot": { "url": "http://100.76.43.74:18800", "token": "abc123" },
 *     "RuiZhi":  { "url": "http://100.76.43.75:18800", "token": "def456" },
 *     "Legacy":  "http://192.168.1.100:18800"
 *   }
 *
 * Values can be either an object { url, token? } or a plain URL string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PEERS_FILE = join(homedir(), ".openclaw", "a2a-peers.json");

export function loadPeers() {
  let raw;
  try {
    raw = readFileSync(PEERS_FILE, "utf-8");
  } catch {
    return {};  // File doesn't exist — that's fine
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error parsing ${PEERS_FILE}: ${err.message}`);
    console.error(`Fix the JSON syntax and retry.`);
    process.exit(1);
  }
}

/**
 * Resolve a peer name to { url, token }.
 * Exits with error if name is not found.
 */
export function resolvePeer(name) {
  const peers = loadPeers();
  const entry = peers[name];
  if (!entry) {
    const available = Object.keys(peers);
    console.error(`Unknown peer "${name}".`);
    if (available.length > 0) {
      console.error(`Available peers: ${available.join(", ")}`);
    } else {
      console.error(`No peers configured. Create ${PEERS_FILE} with:`);
      console.error(`  { "AntiBot": { "url": "http://...", "token": "..." } }`);
    }
    process.exit(1);
  }
  return {
    url: typeof entry === "string" ? entry : entry.url,
    token: typeof entry === "object" ? (entry.token || "") : "",
  };
}

/**
 * Resolve peer URL and token from CLI opts, supporting --peer alias,
 * --peer-url direct, and environment variable fallbacks.
 *
 * @param {object} opts - Parsed CLI options
 * @returns {{ url: string, token: string }}
 */
export function resolveConnection(opts) {
  if (opts.peer) {
    const resolved = resolvePeer(String(opts.peer));
    return {
      url: resolved.url,
      token: typeof opts.token === "string" ? opts.token : (resolved.token || process.env.A2A_TOKEN || ""),
    };
  }
  return {
    url: String(opts["peer-url"] || opts.peerUrl || process.env.A2A_PEER_URL || "").trim(),
    token: typeof opts.token === "string" ? opts.token : (process.env.A2A_TOKEN || ""),
  };
}

export { PEERS_FILE };
