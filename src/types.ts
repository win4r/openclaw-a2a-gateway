/**
 * A2A Gateway Plugin — Standard types
 *
 * These types support the A2A v0.3.0 protocol integration via @a2a-js/sdk.
 */

// ---------------------------------------------------------------------------
// OpenClaw plugin API types
// ---------------------------------------------------------------------------

// Use the official OpenClaw plugin SDK types.
// IMPORTANT: keep these as type-only exports so the plugin has no runtime
// dependency on OpenClaw as an npm package.
export type { OpenClawPluginApi, PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// A2A peer / auth configuration
// ---------------------------------------------------------------------------

export type InboundAuth = "none" | "bearer";
export type PeerAuthType = "bearer" | "apiKey";

export interface PeerAuthConfig {
  type: PeerAuthType;
  token: string;
}

export interface PeerConfig {
  name: string;
  agentCardUrl: string;
  auth?: PeerAuthConfig;
}

// ---------------------------------------------------------------------------
// Agent card configuration (user-provided config, NOT the A2A AgentCard)
// ---------------------------------------------------------------------------

export interface AgentSkillConfig {
  id?: string;
  name: string;
  description?: string;
}

export interface AgentCardConfig {
  name: string;
  description?: string;
  url?: string;
  skills: Array<AgentSkillConfig | string>;
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  agentCard: AgentCardConfig;
  server: {
    host: string;
    port: number;
  };
  storage: {
    tasksDir: string;
  };
  peers: PeerConfig[];
  security: {
    inboundAuth: InboundAuth;
    token?: string;
  };
  routing: {
    defaultAgentId: string;
  };
  limits: {
    maxConcurrentTasks: number;
    maxQueuedTasks: number;
  };
  observability: {
    structuredLogs: boolean;
    exposeMetricsEndpoint: boolean;
    metricsPath: string;
  };
  timeouts?: {
    /**
     * Max time to wait for the underlying OpenClaw agent run to finish (Gateway RPC `agent`).
     * Long-running prompts should use async task mode (blocking=false) + tasks/get polling.
     */
    agentResponseTimeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface OutboundSendResult {
  ok: boolean;
  statusCode: number;
  response: unknown;
}
