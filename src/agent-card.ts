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
  const agentCard = config.agentCard || ({} as GatewayConfig["agentCard"]);
  const server = config.server || { host: "0.0.0.0", port: 18800 };
  const configuredUrl = agentCard.url;

  const useDerivedGrpcUrl = agentCard.grpcProxy === true;
  const fallbackHost = server.host === "0.0.0.0" ? "localhost" : server.host;
  const fallbackUrl = `http://${fallbackHost}:${server.port}/a2a/jsonrpc`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const security: AgentCard["security"] = [];

  const security_ = config.security || { inboundAuth: "none", token: "" };
  if (security_.inboundAuth === "bearer") {
    securitySchemes["bearer"] = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearer: [] });
  }

  const grpcPort = server.port + 1;
  const grpcHost = server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : server.host;
  const grpcProxy = useDerivedGrpcUrl
    ? `${new URL(configuredUrl || fallbackUrl).origin}`
    : `${grpcHost}:${grpcPort}`;

  const jsonRpcUrl = configuredUrl || fallbackUrl;
  const restUrl = `${new URL(configuredUrl || fallbackUrl).origin}/a2a/rest`;

  return {
    protocolVersion: "1.0",
    version: "1.0.0",
    name: agentCard.name || "OpenClaw A2A Gateway",
    description: agentCard.description || "A2A bridge for OpenClaw agents",
    url: jsonRpcUrl,
    skills: (agentCard.skills || []).map((entry, index) => toSkill(entry, index)),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes,
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    // v1.0 protocol — advertised interfaces. Order matters: first
    // entry is the preferred one. v0.3 entry second so legacy
    // peers (Phronesis pre-v1.0) can still discover us when they
    // walk the card and pick the matching protocolVersion.
    supportedInterfaces: [
      {
        url: jsonRpcUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
      {
        url: jsonRpcUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "0.3",
      },
    ],
    // Legacy v0.3 transport list. Preserved verbatim for backward
    // compat with tools that still read `additionalInterfaces[]`.
    additionalInterfaces: [
      { url: jsonRpcUrl, transport: "JSONRPC" },
      { url: restUrl, transport: "HTTP+JSON" },
      { url: grpcProxy, transport: "GRPC" },
    ],
  } as unknown as AgentCard;
}
