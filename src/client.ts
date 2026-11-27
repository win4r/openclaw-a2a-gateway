import { v4 as uuidv4 } from "uuid";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
  type HttpHeaders,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import { Role } from "@a2a-js/sdk";
import type { Message, SendMessageRequest } from "@a2a-js/sdk";
import { LEGACY_METHOD_MESSAGE_SEND } from "@a2a-js/sdk/compat/v0_3";
import { toV1Parts } from "./types-v1.js";

import { ConnectionPool, type ConnectionPoolConfig } from "./connection-pool.js";
import type { OutboundSendResult, PeerConfig, RetryConfig } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";
import { withRetry } from "./peer-retry.js";
import {
  orderTransports,
  adaptiveOrderTransports,
  isRetryableTransportError,
  TransportStats,
  type TransportEndpoint,
} from "./transport-fallback.js";

const nativeFetch = globalThis.fetch;

/**
 * Build an AuthenticationHandler for bearer or apiKey auth.
 */
function createAuthHandler(peer: PeerConfig): AuthenticationHandler | undefined {
  const auth = peer.auth;
  if (!auth?.token) return undefined;

  const headerKey = auth.type === "bearer" ? "authorization" : "x-api-key";
  const headerValue = auth.type === "bearer" ? `Bearer ${auth.token}` : auth.token;

  return {
    headers: async (): Promise<HttpHeaders> => ({
      [headerKey]: headerValue,
    }),
    shouldRetryWithHeaders: async () => undefined,
  };
}

/**
 * Parse agentCardUrl into base URL and path.
 */
function parseAgentCardUrl(agentCardUrl: string): { baseUrl: string; path: string } {
  const parsed = new URL(agentCardUrl);
  return {
    baseUrl: parsed.origin,
    path: parsed.pathname,
  };
}

export class A2AClient {
  private readonly poolConfig?: ConnectionPoolConfig;
  private connectionPool: ConnectionPool | null = null;
  private destroyed = false;

  /**
   * Per-peer transport performance stats for adaptive ordering.
   * Bio-inspired: cells learn which signal pathway works best for a given
   * stimulus type and preferentially activate it (pathway selection).
   */
  private readonly peerTransportStats = new Map<string, TransportStats>();

  constructor(config?: { poolConfig?: ConnectionPoolConfig }) {
    this.poolConfig = config?.poolConfig;
  }

  private getOrCreateStats(peerName: string): TransportStats {
    let stats = this.peerTransportStats.get(peerName);
    if (!stats) {
      stats = new TransportStats();
      this.peerTransportStats.set(peerName, stats);
    }
    return stats;
  }

  private getOrCreatePool(): ConnectionPool {
    if (this.destroyed) {
      throw new Error("A2AClient has been destroyed");
    }

    if (!this.connectionPool) {
      this.connectionPool = new ConnectionPool(this.poolConfig);
    }

    return this.connectionPool;
  }

  private createBaseFetch(): typeof fetch {
    // Preserve testability: if a test or embedding runtime overrides fetch,
    // honor that override instead of bypassing it with the pooled transport.
    if (globalThis.fetch !== nativeFetch) {
      return globalThis.fetch.bind(globalThis) as typeof fetch;
    }

    return ((input: RequestInfo | URL, init?: RequestInit) =>
      this.getOrCreatePool().fetch(input, init)) as typeof fetch;
  }

  private createFetch(peer: PeerConfig): typeof fetch {
    const baseFetch = this.createBaseFetch();
    const authHandler = createAuthHandler(peer);

    return authHandler
      ? createAuthenticatingFetchWithRetry(baseFetch, authHandler)
      : baseFetch;
  }

  /**
   * Create a ClientFactory with auth-aware fetch for a given peer.
   */
  private buildFactory(peer: PeerConfig): { factory: ClientFactory; path: string } {
    const { baseUrl: _baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const authFetch = this.createFetch(peer);

    // Inject auth fetch into card resolver and all transports
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ],
    });

    return { factory: new ClientFactory(options), path };
  }

  /**
   * Discover a peer's Agent Card using the SDK resolver.
   * Used for both card discovery and health probes.
   *
   * @param timeoutMs  Override timeout (default 30s; health checks use 5s).
   */
  async discoverAgentCard(peer: PeerConfig, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const { factory } = this.buildFactory(peer);
    const authFetch = this.createFetch(peer);

    // createFromUrl resolves the card internally
    await factory.createFromUrl(baseUrl, path);

    const response = await authFetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Agent Card lookup failed with status ${response.status}`);
    }

    return response.json();
  }

  /**
   * Send a message to a peer agent using the A2A SDK Client.
   *
   * When a PeerHealthManager and RetryConfig are provided, the call is
   * wrapped with circuit-breaker checks and exponential-backoff retries.
   */
  async sendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    options?: {
      healthManager?: PeerHealthManager;
      retryConfig?: RetryConfig;
      log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void;
    },
  ): Promise<OutboundSendResult> {
    const healthManager = options?.healthManager;
    const retryConfig = options?.retryConfig;

    // Circuit breaker: reject immediately if peer is unavailable
    if (healthManager && !healthManager.isAvailable(peer.name)) {
      return {
        ok: false,
        statusCode: 503,
        response: { error: `Circuit open: peer "${peer.name}" is unavailable` },
      };
    }

    const doSend = () => this.doSendMessage(peer, message, options?.log);

    let result: OutboundSendResult;
    if (retryConfig && retryConfig.maxRetries > 0) {
      result = await withRetry(doSend, retryConfig, options?.log, peer.name);
    } else {
      result = await doSend();
    }

    // Update health manager
    if (healthManager) {
      if (result.ok) {
        healthManager.recordSuccess(peer.name);
      } else {
        healthManager.recordFailure(peer.name);
      }
    }

    return result;
  }

  /**
   * Core send logic with automatic transport fallback.
   *
   * 1. Resolve the Agent Card to discover available transports.
   * 2. Build the ordered list of transports (JSON-RPC > REST > gRPC).
   * 3. Try sending via the preferred transport; on transport-level errors
   *    (connection, timeout, 5xx) fall back to the next available transport.
   * 4. Auth errors (401/403) and A2A protocol errors are NOT retried on
   *    a different transport — they would fail identically.
   */
  private async doSendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void,
  ): Promise<OutboundSendResult> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const { factory } = this.buildFactory(peer);

    // ------------------------------------------------------------------
    // 1. Build the outbound A2A message (shared across all transports)
    // ------------------------------------------------------------------
    const targetAgentId = typeof (message as any)?.agentId === "string" ? String((message as any).agentId) : "";

    const role =
      String((message as any)?.role ?? "user").toLowerCase() === "agent"
        ? Role.ROLE_AGENT
        : Role.ROLE_USER;

    const outboundMessage: Message = {
      messageId: (message.messageId as string) || uuidv4(),
      contextId: typeof (message as any)?.contextId === "string" ? (message as any).contextId : "",
      taskId: typeof (message as any)?.taskId === "string" ? (message as any).taskId : "",
      role,
      parts: toV1Parts(
        (message.parts as unknown[] | undefined) ?? [
          String(message.text || message.message || ""),
        ],
      ),
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };

    if (targetAgentId) {
      // v1 MessageFns.toJSON drops unknown fields, so route agentId through
      // metadata for peer-side routing (OpenClaw extension).
      outboundMessage.metadata = { ...(outboundMessage.metadata ?? {}), agentId: targetAgentId };
    }

    const sendParams: SendMessageRequest = {
      tenant: "",
      message: outboundMessage,
      configuration: undefined,
      metadata: undefined,
    };

    const serviceParameters: Record<string, string> = {};
    if (peer.auth?.token) {
      if (peer.auth.type === "bearer") {
        serviceParameters.authorization = `Bearer ${peer.auth.token}`;
      } else {
        serviceParameters["x-api-key"] = peer.auth.token;
      }
    }

    const requestOptions = {
      serviceParameters: Object.keys(serviceParameters).length ? serviceParameters : undefined,
    };

    // ------------------------------------------------------------------
    // 2. Resolve the Agent Card and build ordered transport list
    // ------------------------------------------------------------------
    let transports: TransportEndpoint[];

    try {
      // Use SDK's card resolver (which already handles auth)
      const resolver = new DefaultAgentCardResolver({
        fetchImpl: this.createFetch(peer),
      });
      const agentCard = await resolver.resolve(baseUrl, path);

      // Legacy peer detection (#95 dual-stack): SDK 1.x transports negotiate
      // v1 only, so speak legacy JSON-RPC directly for v0.3 peers.
      const cardAny = agentCard as unknown as Record<string, unknown>;
      const supportedIfaces = Array.isArray(cardAny.supportedInterfaces)
        ? (cardAny.supportedInterfaces as Array<Record<string, unknown>>)
        : [];
      const cardIsLegacy =
        supportedIfaces.length === 0 ||
        String(cardAny.protocolVersion ?? "").startsWith("0.");
      if (cardIsLegacy) {
        return this.sendViaLegacyJsonRpc(peer, cardAny, outboundMessage, requestOptions);
      }

      // Build transport list, normalizing BOTH card generations:
      //   v0.3: url + preferredTransport + additionalInterfaces[]
      //   v1:   supportedInterfaces[] ({ url, protocolBinding })
      const legacyCard = agentCard as unknown as {
        url?: string;
        preferredTransport?: string;
        additionalInterfaces?: { url?: string; transport?: string }[];
      };

      const allInterfaces: TransportEndpoint[] = [];
      const seenEndpoints = new Set<string>();
      const pushEndpoint = (url?: string, transport?: string) => {
        if (!url || !transport) return;
        const key = `${transport}:${url}`;
        if (seenEndpoints.has(key)) return;
        seenEndpoints.add(key);
        allInterfaces.push({ url, transport });
      };

      // v0.3 generation first (preferred entry keeps priority), then v1.
      pushEndpoint(legacyCard.url, legacyCard.preferredTransport ?? "JSONRPC");
      for (const iface of legacyCard.additionalInterfaces ?? []) {
        pushEndpoint(iface.url, iface.transport);
      }
      for (const iface of agentCard.supportedInterfaces ?? []) {
        pushEndpoint(iface.url, iface.protocolBinding);
      }
      if (allInterfaces.length === 0) {
        pushEndpoint(legacyCard.url, "JSONRPC");
      }

      // Bio-inspired: use adaptive transport ordering when we have stats
      // for this peer (pathway selection based on past performance).
      const stats = this.getOrCreateStats(peer.name);
      transports = allInterfaces.some((ep) => stats.count(ep.transport) > 0)
        ? adaptiveOrderTransports(allInterfaces, stats)
        : orderTransports(allInterfaces);
    } catch {
      // Card resolution failed — fall back to single-transport path
      // (let the SDK pick whatever it can)
      transports = [];
    }

    // ------------------------------------------------------------------
    // 3. Fallback loop: try each transport in priority order
    // ------------------------------------------------------------------
    if (transports.length <= 1) {
      // No fallback candidates — use original single-transport path
      return this.doSendViaFactory(factory, baseUrl, path, sendParams, requestOptions);
    }

    let lastError: unknown;
    const loopStats = this.getOrCreateStats(peer.name);
    for (let i = 0; i < transports.length; i++) {
      const endpoint = transports[i];

      log?.("info", "transport.try", {
        peer: peer.name,
        transport: endpoint.transport,
        url: endpoint.url,
        attempt: i + 1,
        total: transports.length,
      });

      const transportStartedAt = Date.now();
      try {
        const result = await this.doSendViaTransport(
          peer,
          endpoint,
          sendParams,
          requestOptions,
        );

        // Record transport performance for adaptive ordering
        loopStats.record(endpoint.transport, result.ok, Date.now() - transportStartedAt);

        // Success or non-retryable failure → return immediately
        if (result.ok || !isRetryableTransportError(result)) {
          if (i > 0) {
            log?.("info", "transport.fallback.success", {
              peer: peer.name,
              transport: endpoint.transport,
              url: endpoint.url,
              attemptIndex: i,
            });
          }
          return result;
        }

        // Retryable failure — try next transport
        lastError = result;
        log?.("warn", "transport.fallback", {
          peer: peer.name,
          failedTransport: endpoint.transport,
          statusCode: result.statusCode,
          error: (result.response as any)?.error,
        });
      } catch (error: unknown) {
        // Record failure for adaptive ordering
        loopStats.record(endpoint.transport, false, Date.now() - transportStartedAt);

        if (!isRetryableTransportError(error)) {
          // Non-retryable error (auth, protocol) → stop immediately
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            statusCode: 500,
            response: { error: errorMessage },
          };
        }

        // Retryable error — try next transport
        lastError = error;
        log?.("warn", "transport.fallback", {
          peer: peer.name,
          failedTransport: endpoint.transport,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // All transports exhausted
    const errorMessage = lastError instanceof Error
      ? lastError.message
      : typeof lastError === "object" && lastError && "response" in lastError
        ? ((lastError as any).response as any)?.error ?? String(lastError)
        : String(lastError);

    return {
      ok: false,
      statusCode: 500,
      response: { error: `All transports failed for peer "${peer.name}": ${errorMessage}` },
    };
  }

  /**
   * Legacy v0.3 peers: raw JSON-RPC "message/send" with a v0.3-shaped
   * message. Keeps real-world 0.3 deployments working under SDK 1.x.
   */
  private async sendViaLegacyJsonRpc(
    peer: PeerConfig,
    card: Record<string, unknown>,
    message: Message,
    requestOptions: { serviceParameters?: Record<string, string> },
  ): Promise<OutboundSendResult> {
    // Use the live fetch chain (auth-wrapped, mockable) — NOT the
    // module-captured nativeFetch, which predates any globalThis.fetch
    // stubbing in tests/embedders.
    const doFetch = this.createFetch(peer);
    const endpoint = String(card.url ?? "");
    if (!endpoint) {
      return { ok: false, statusCode: 500, response: { error: "Legacy Agent Card has no service url" } };
    }

    const extraMeta = (message.metadata ?? {}) as Record<string, unknown>;

    const legacyParts = (message.parts ?? []).map((part) => {
      const fileMeta: Record<string, unknown> = {
        ...(part.filename ? { name: part.filename } : {}),
        ...(part.mediaType ? { mimeType: part.mediaType } : {}),
      };
      const content = part.content;
      if (!content) return { kind: "text", text: "" };
      switch (content.$case) {
        case "text":
          return { kind: "text", text: content.value };
        case "url":
          return { kind: "file", file: { uri: content.value, ...fileMeta } };
        case "raw": {
          const bytes = Buffer.from(content.value).toString("base64");
          return { kind: "file", file: { bytes, ...fileMeta } };
        }
        case "data":
          return { kind: "data", data: content.value };
        default:
          return { kind: "text", text: "" };
      }
    });

    const legacyMessage: Record<string, unknown> = {
      kind: "message",
      messageId: message.messageId,
      role: message.role === Role.ROLE_AGENT ? "agent" : "user",
      parts: legacyParts,
      ...(message.contextId ? { contextId: message.contextId } : {}),
      ...(message.taskId ? { taskId: message.taskId } : {}),
      // Preserve the OpenClaw agentId routing extension for legacy peers,
      // which expect it as a top-level message field.
      ...(typeof extraMeta.agentId === "string" ? { agentId: extraMeta.agentId } : {}),
    };

    const headers: Record<string, string> = { "content-type": "application/json" };
    const serviceParams = requestOptions.serviceParameters ?? {};
    if (serviceParams.authorization) headers.authorization = serviceParams.authorization;
    if (serviceParams["x-api-key"]) headers["x-api-key"] = serviceParams["x-api-key"];

    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          method: LEGACY_METHOD_MESSAGE_SEND,
          params: { message: legacyMessage },
        }),
      });

      const payload = (await response.json().catch(() => undefined)) as
        | { result?: unknown; error?: { code?: number; message?: string } }
        | undefined;

      if (!response.ok || !payload || payload.error) {
        return {
          ok: false,
          statusCode: response.status || 500,
          response: payload?.error ?? payload ?? { error: `legacy send failed (${response.status})` },
        };
      }

      return { ok: true, statusCode: response.status, response: payload.result };
    } catch (error: unknown) {
      return {
        ok: false,
        statusCode: 500,
        response: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Send via the SDK's ClientFactory (original single-transport path).
   */
  private async doSendViaFactory(
    factory: ClientFactory,
    baseUrl: string,
    path: string,
    sendParams: SendMessageRequest,
    requestOptions: { serviceParameters?: Record<string, string> },
  ): Promise<OutboundSendResult> {
    try {
      const client = await factory.createFromUrl(baseUrl, path);
      const result = await client.sendMessage(sendParams, requestOptions);
      return {
        ok: true,
        statusCode: 200,
        response: result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        statusCode: 500,
        response: { error: errorMessage },
      };
    }
  }

  /**
   * Send via a specific transport endpoint, creating the transport directly.
   */
  private async doSendViaTransport(
    peer: PeerConfig,
    endpoint: TransportEndpoint,
    sendParams: SendMessageRequest,
    requestOptions: { serviceParameters?: Record<string, string> },
  ): Promise<OutboundSendResult> {
    const authFetch = this.createFetch(peer);

    let transport;

    switch (endpoint.transport) {
      case "JSONRPC": {
        const factory = new JsonRpcTransportFactory({ fetchImpl: authFetch });
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      case "HTTP+JSON": {
        const factory = new RestTransportFactory({ fetchImpl: authFetch });
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      case "GRPC": {
        const factory = new GrpcTransportFactory();
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      default:
        return {
          ok: false,
          statusCode: 500,
          response: { error: `Unsupported transport: ${endpoint.transport}` },
        };
    }

    try {
      const result = await transport.sendMessage(sendParams, requestOptions);
      return {
        ok: true,
        statusCode: 200,
        response: result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      // Re-throw so the fallback loop can classify the error
      throw error;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.connectionPool?.destroy();
    this.connectionPool = null;
  }
}
