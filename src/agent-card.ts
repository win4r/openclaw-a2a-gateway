import type { AgentCard, AgentInterface, AgentSkill } from "@a2a-js/sdk";
import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  if (typeof entry === "string") {
    return {
      id: `skill-${index + 1}`,
      name: entry,
      description: entry,
      tags: [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    };
  }

  return {
    id: entry.id || `skill-${index + 1}`,
    name: entry.name,
    description: entry.description || entry.name,
    tags: [],
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

function agentInterface(url: string, protocolBinding: AgentInterface["protocolBinding"]): AgentInterface {
  return {
    url,
    protocolBinding,
    tenant: "",
    protocolVersion: A2A_PROTOCOL_VERSION,
  };
}

export function buildAgentCard(config: GatewayConfig): AgentCard {
  const agentCard = config.agentCard || ({} as GatewayConfig["agentCard"]);
  const server = config.server || { host: "0.0.0.0", port: 18800 };
  const configuredUrl = agentCard.url;
  const fallbackHost = server.host === "0.0.0.0" ? "localhost" : server.host;
  const fallbackUrl = `http://${fallbackHost}:${server.port}/a2a/jsonrpc`;

  const jsonRpcUrl = configuredUrl || fallbackUrl;
  const origin = new URL(jsonRpcUrl).origin;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const securityRequirements: AgentCard["securityRequirements"] = [];

  const security_ = config.security || { inboundAuth: "none", token: "" };
  if (security_.inboundAuth === "bearer") {
    securitySchemes.bearer = {
      type: "http",
      scheme: "bearer",
    };
    securityRequirements.push({ bearer: [] });
  }

  const grpcPort = server.port + 1;
  const grpcHost = server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : server.host;

  return {
    name: agentCard.name || "OpenClaw A2A Gateway",
    description: agentCard.description || "A2A bridge for OpenClaw agents",
    version: "1.0.0",
    supportedInterfaces: [
      agentInterface(jsonRpcUrl, "JSONRPC"),
      agentInterface(`${origin}/a2a/rest`, "HTTP+JSON"),
      agentInterface(`${grpcHost}:${grpcPort}`, "GRPC"),
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: (agentCard.skills || []).map((entry, index) => toSkill(entry, index)),
    signatures: [],
  };
}

/** Primary JSON-RPC endpoint URL from a v1 Agent Card. */
export function primaryAgentUrl(card: AgentCard): string {
  return card.supportedInterfaces[0]?.url ?? "";
}

/** Protocol version exposed on the primary interface. */
export function primaryProtocolVersion(card: AgentCard): string {
  return card.supportedInterfaces[0]?.protocolVersion ?? "";
}
