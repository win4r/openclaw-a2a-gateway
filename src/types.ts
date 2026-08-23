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

/**
 * Subset of `ObservabilityConfig` devoted to W3C `traceparent` propagation.
 *
 * Lives next to `GatewayConfig["observability"]["traceparent"]` so the
 * parser in `index.ts` can declare the shape with `satisfies` while the
 * runtime keeps a single source of truth.
 */
export interface ObservabilityConfigTraceparent {
  enabled: boolean;
  propagateOnConnect?: boolean;
  /**
   * Negotiated `protocol` floor for traceparent gating.  When the
   * Gateway negotiates below this number, `traceparent` is dropped
   * from outgoing frames.  Default 5.
   */
  minProtocolRequired?: number;
  /**
   * Highest protocol version the plugin advertises during `connect`.
   * Default 5.
   */
  maxProtocol?: number;
}

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
  grpcProxy?: boolean;
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

export interface DnsDiscoveryConfig {
  enabled: boolean;
  /** DNS-SD service name to query. Default: "_a2a._tcp.local" */
  serviceName: string;
  /** How often to re-query DNS (ms). Default: 30000 (30s). */
  refreshIntervalMs: number;
  /** Whether discovered peers supplement static config peers. Default: true. */
  mergeWithStatic: boolean;
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
    /** Bio-inspired Hill equation affinity scoring config. When set, routing uses scored matching. */
    affinity?: import("./routing-rules.js").AffinityConfig;
  };
  limits: {
    maxConcurrentTasks: number;
    maxQueuedTasks: number;
    /** Bio-inspired Michaelis-Menten soft concurrency config. When set, adds progressive delay under load. */
    saturation?: import("./saturation-model.js").SaturationConfig;
  };
  observability: {
    structuredLogs: boolean;
    exposeMetricsEndpoint: boolean;
    metricsPath: string;
    metricsAuth: "none" | "bearer";
    auditLogPath: string;
    /**
     * W3C traceparent propagation switch.
     *
     * `enabled` defaults to true.  When set to false, the plugin still
     * connects and dispatches normally — it just stops stamping
     * `traceparent` onto outbound IPC frames and peer HTTP/gRPC calls.
     *
     * `propagateOnConnect` is reserved for forward compatibility: today
     * the Gateway ignores `traceparent` on the initial `connect` frame
     * (per `docs/gateway/opentelemetry.md`), so this switch is purely
     * diagnostic.
     *
     * `minProtocolRequired` and `maxProtocol` gate the protocol
     * negotiation range during `connect`.  When the negotiated
     * `protocol` is below `minProtocolRequired`, the plugin drops
     * `traceparent` from subsequent `req` frames — this avoids the
     *    `invalid request frame: at root: unexpected property 'traceparent'`
     * error older Gateway builds return when their `RequestFrameSchema`
     * strict-validates top-level keys.  Defaults: `minProtocolRequired=5`
     * (the version that introduces `traceparent` in the schema),
     * `maxProtocol=5`.
     *
     * @see src/internal/traceparent.ts for the formatter / validator.
     * @see docs/traceparent.md for the protocol-version dependency.
     */
    traceparent?: {
      enabled: boolean;
      propagateOnConnect?: boolean;
      /**
       * Negotiated `protocol` floor for traceparent gating.  When the
       * Gateway negotiates below this number, `traceparent` is dropped
       * from outgoing frames so the schema-validated Gateway doesn't
       * reject them as "unexpected property".  Default 5.
       */
      minProtocolRequired?: number;
      /**
       * Highest protocol version the plugin advertises during
       * `connect`.  The Gateway picks a value in
       * `[minProtocol=3, maxProtocol]`.  Default 5.
       */
      maxProtocol?: number;
    };
  };
  timeouts?: {
    /**
     * Max time to wait for the underlying OpenClaw agent run to finish (Gateway RPC `agent`).
     * Long-running prompts should use async task mode (blocking=false) + tasks/get polling.
     */
    agentResponseTimeoutMs?: number;
  };
  resilience: PeerResilienceConfig;
  /** DNS-SD discovery configuration. Disabled by default. */
  discovery: DnsDiscoveryConfig;
  /** Bio-inspired Quorum Sensing config for adaptive discovery polling. */
  quorum?: import("./quorum-discovery.js").QuorumConfig;
  /** mDNS advertisement configuration. Disabled by default. */
  advertise: import("./dns-responder.js").MdnsAdvertiseConfig;
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
  /**
   * Soft failure threshold (< failureThreshold) to enter DESENSITIZED state.
   * When set, the circuit goes CLOSED → DESENSITIZED → OPEN instead of
   * directly CLOSED → OPEN. Analogous to receptor phosphorylation reducing
   * but not blocking signal transduction.
   *
   * @see Bhalla, U.S. & Bhatt, D.K. (2007) "Receptor desensitization
   *   produces complex dose-response" BMC Syst Biol 1:54.
   */
  softThreshold?: number;
  /**
   * Fraction of traffic allowed in DESENSITIZED state (0-1).
   * Uses deterministic round-robin (not random) for testability.
   * @default 0.5
   */
  desensitizedCapacity?: number;
  /**
   * Recovery rate constant (k) for exponential recovery curve:
   *   capacity(t) = 1 - exp(-k * t_seconds)
   *
   * When set, RECOVERING uses gradual capacity increase instead of
   * single-probe half-open behavior. Higher k = faster recovery.
   * Analogous to receptor recycling rate after internalization.
   * @default undefined (single-probe mode, equivalent to legacy half-open)
   */
  recoveryRateConstant?: number;
}

export interface PeerResilienceConfig {
  healthCheck: HealthCheckConfig;
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
}

export type CircuitState = "closed" | "desensitized" | "open" | "recovering";
export type HealthStatus = "healthy" | "unhealthy" | "unknown";

export interface PeerState {
  health: HealthStatus;
  circuit: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastCheckAt: number | null;
  /** Timestamp (ms) when RECOVERING state began. */
  recoveringSince?: number | null;
}

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface OutboundSendResult {
  ok: boolean;
  statusCode: number;
  response: unknown;
}
