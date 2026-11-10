import type { AgentCard, AgentSkill, SecurityScheme } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  const base =
    typeof entry === "string"
      ? { id: `skill-${index + 1}`, name: entry, description: entry }
      : {
          id: entry.id || `skill-${index + 1}`,
          name: entry.name,
          description: entry.description || entry.name,
        };

  return {
    id: base.id,
    name: base.name,
    description: base.description,
    tags: [],
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

/**
 * Build a v1 AgentCard.
 *
 * Dual-stack note (#95): the first supportedInterface is preferred by
 * conforming clients. We advertise JSONRPC twice — v1.0 and v0.3 — so
 * legacy peers can negotiate down without a second card fetch.
 */
export function buildAgentCard(config: GatewayConfig): AgentCard {
  const agentCard = config.agentCard || ({} as GatewayConfig["agentCard"]);
  const server = config.server || { host: "0.0.0.0", port: 18800 };
  const configuredUrl = agentCard.url;

  const useDerivedGrpcUrl = agentCard.grpcProxy === true;
  const fallbackHost = server.host === "0.0.0.0" ? "localhost" : server.host;
  const fallbackUrl = `http://${fallbackHost}:${server.port}/a2a/jsonrpc`;
  const jsonRpcUrl = configuredUrl || fallbackUrl;
  const restUrl = `${new URL(jsonRpcUrl).origin}/a2a/rest`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const securityRequirements: AgentCard["securityRequirements"] = [];

  const security_ = config.security || { inboundAuth: "none", token: "" };
  if (security_.inboundAuth === "bearer") {
    const scheme: SecurityScheme = {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: { description: "", scheme: "Bearer", bearerFormat: "" },
      },
    };
    securitySchemes["bearer"] = scheme;
    securityRequirements.push({ schemes: { bearer: { list: [] } } });
  }

  const grpcPort = server.port + 1;
  const grpcHost = server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : server.host;
  const grpcProxy = useDerivedGrpcUrl
    ? `${new URL(configuredUrl || fallbackUrl).origin}`
    : `${grpcHost}:${grpcPort}`;

  return {
    name: agentCard.name || "OpenClaw A2A Gateway",
    description: agentCard.description || "A2A bridge for OpenClaw agents",
    version: "1.0.0",
    supportedInterfaces: [
      { url: jsonRpcUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
      { url: jsonRpcUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "0.3" },
      { url: restUrl, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: "1.0" },
      { url: grpcProxy, protocolBinding: "GRPC", tenant: "", protocolVersion: "1.0" },
    ],
    provider: undefined,
    documentationUrl: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: (agentCard.skills || []).map((entry, index) => toSkill(entry, index)),
    signatures: [],
  };
}
