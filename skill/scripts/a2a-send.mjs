#!/usr/bin/env node
/**
 * Send a message to an A2A peer using the official @a2a-js/sdk.
 *
 * Usage:
 *   node a2a-send.mjs --peer-url <PEER_BASE_URL> --token <TOKEN> --message "Hello!"
 *   node a2a-send.mjs --peer-url http://100.76.43.74:18800 --token abc123 --message "What is your name?"
 *
 * Optional (OpenClaw extension):
 *   --agent-id <openclaw-agent-id>   Route the inbound A2A request to a specific OpenClaw agentId on the peer.
 *                                   Note: this works reliably over JSON-RPC/REST. gRPC transport may drop unknown
 *                                   Message fields, so the script will prefer JSON-RPC when --agent-id is used.
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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    opts[key] = args[i + 1];
  }
  if (!opts["peer-url"] || !opts.message) {
    console.error(
      "Usage: node a2a-send.mjs --peer-url <URL> --token <TOKEN> --message <TEXT> [--agent-id <openclaw-agent-id>]"
    );
    process.exit(1);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const peerUrl = opts["peer-url"];
  const token = opts.token;
  const message = opts.message;
  const targetAgentId = opts["agent-id"] || opts.agentId;

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

  const overrides = {
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
    transports: [
      // Keep JSON-RPC first as the default (most compatible)
      new JsonRpcTransportFactory({ fetchImpl: authFetch }),
      new RestTransportFactory({ fetchImpl: authFetch }),
      // GRPC is optional; requires server gRPC to be reachable (typically port+1)
      new GrpcTransportFactory(),
    ],
  };

  // OpenClaw extension routing uses a non-standard Message field (agentId).
  // gRPC transport uses protobuf Message and may drop unknown fields, so prefer
  // JSON-RPC/REST when targetAgentId is set.
  if (targetAgentId) {
    overrides.preferredTransports = ["JSONRPC", "HTTP+JSON"]; 
  }

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, overrides)
  );

  // Discover agent card and create client
  const client = await factory.createFromUrl(peerUrl);

  // Send message
  const outboundMessage = {
    kind: "message",
    messageId: randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: message }],
    ...(targetAgentId ? { agentId: targetAgentId } : {}),
  };

  const result = await client.sendMessage(
    { message: outboundMessage },
    token ? { serviceParameters: { authorization: `Bearer ${token}` } } : undefined,
  );

  // Extract response text
  const response = result;
  if (response?.kind === "message") {
    const text = response.parts?.find((p) => p.kind === "text")?.text;
    console.log(text || JSON.stringify(response, null, 2));
  } else if (response?.kind === "task") {
    const text = response.status?.message?.parts?.find((p) => p.kind === "text")?.text;
    console.log(text || JSON.stringify(response, null, 2));
  } else {
    console.log(JSON.stringify(response, null, 2));
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
