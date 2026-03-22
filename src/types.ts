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

export interface FileSecurityConfig {
  /** Allowed MIME type patterns (e.g. "image/*", "application/pdf"). */
  allowedMimeTypes: string[];
  /** Max file size in bytes for URI-based files (default 50MB). */
  maxFileSizeBytes: number;
  /** Max file size in bytes for inline base64 files (default 10MB). */
  maxInlineFileSizeBytes: number;
  /** URI hostname allowlist patterns (e.g. "*.example.com"). Empty = allow all public hosts. */
  fileUriAllowlist: string[];
}

export interface SecurityConfig extends FileSecurityConfig {
  inboundAuth: InboundAuth;
  token?: string;
  tokens?: string[];
  /** Runtime-merged set of all valid tokens (from `token` + `tokens`, deduplicated). */
  validTokens: Set<string>;
}

export interface GatewayConfig {
  agentCard: AgentCardConfig;
  server: {
    host: string;
    port: number;
  };
  storage: {
    tasksDir: string;
    taskTtlHours: number;
    cleanupIntervalMinutes: number;
  };
  peers: PeerConfig[];
  security: SecurityConfig;
  routing: {
    defaultAgentId: string;
    rules: import("./routing-rules.js").RoutingRule[];
  };
  limits: {
    maxConcurrentTasks: number;
    maxQueuedTasks: number;
  };
  observability: {
    structuredLogs: boolean;
    exposeMetricsEndpoint: boolean;
    metricsPath: string;
    metricsAuth: "none" | "bearer";
    auditLogPath: string;
  };
  timeouts?: {
    /**
     * Max time to wait for the underlying OpenClaw agent run to finish (Gateway RPC `agent`).
     * Long-running prompts should use async task mode (blocking=false) + tasks/get polling.
     */
    agentResponseTimeoutMs?: number;
  };
  resilience: PeerResilienceConfig;
}

// ---------------------------------------------------------------------------
// Peer resilience configuration
// ---------------------------------------------------------------------------

export interface HealthCheckConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

export interface PeerResilienceConfig {
  healthCheck: HealthCheckConfig;
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
}

export type CircuitState = "closed" | "open" | "half-open";
export type HealthStatus = "healthy" | "unhealthy" | "unknown";

export interface PeerState {
  health: HealthStatus;
  circuit: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastCheckAt: number | null;
}

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface OutboundSendResult {
  ok: boolean;
  statusCode: number;
  response: unknown;
}
