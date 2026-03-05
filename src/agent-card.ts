import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  if (typeof entry === "string") {
    return {
      id: `skill-${index + 1}`,
      name: entry,
      description: entry,
      tags: [],
    };
  }

  return {
    id: entry.id || `skill-${index + 1}`,
    name: entry.name,
    description: entry.description || entry.name,
    tags: [],
  };
}

export function buildAgentCard(config: GatewayConfig): AgentCard {
  const configuredUrl = config.agentCard.url;
  const fallbackHost = config.server.host === "0.0.0.0" ? "localhost" : config.server.host;
  const fallbackUrl = `http://${fallbackHost}:${config.server.port}/a2a/jsonrpc`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const security: AgentCard["security"] = [];

  if (config.security.inboundAuth === "bearer") {
    securitySchemes["bearer"] = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearer: [] });
  }

  const grpcPort = config.server.port + 1;
  const grpcHost = config.server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : config.server.host;

  return {
    protocolVersion: "0.3.0",
    version: "1.0.0",
    name: config.agentCard.name,
    description: config.agentCard.description || "A2A bridge for OpenClaw agents",
    url: configuredUrl || fallbackUrl,
    skills: config.agentCard.skills.map((entry, index) => toSkill(entry, index)),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    securitySchemes,
    security,
    supportsAuthenticatedExtendedCard: false,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    additionalInterfaces: [
      { url: configuredUrl || fallbackUrl, transport: "JSONRPC" },
      { url: `${new URL(configuredUrl || fallbackUrl).origin}/a2a/rest`, transport: "HTTP+JSON" },
      { url: `${grpcHost}:${grpcPort}`, transport: "GRPC" },
    ],
  };
}
