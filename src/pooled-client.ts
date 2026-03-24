/**
 * Pooled A2A Client with Connection Pool
 *
 * Implements A2A client with connection pooling to reduce latency and resource overhead.
 * Injects http.Agent/https.Agent into fetch to enable true HTTP connection reuse.
 */

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
import type { MessageSendParams, Message } from "@a2a-js/sdk";

import { ConnectionPool, type ConnectionPoolConfig } from "./connection-pool.js";
import type { OutboundSendResult, PeerConfig, RetryConfig } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";
import { withRetry } from "./peer-retry.js";

/**
 * Build an AuthenticationHandler for bearer or apiKey auth
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
 * Parse agentCardUrl into base URL and path
 */
function parseAgentCardUrl(agentCardUrl: string): { baseUrl: string; path: string } {
  const parsed = new URL(agentCardUrl);
  return {
    baseUrl: parsed.origin,
    path: parsed.pathname,
  };
}

export class PooledA2AClient {
  private connectionPool: ConnectionPool;

  constructor(config?: { poolConfig?: ConnectionPoolConfig }) {
    this.connectionPool = new ConnectionPool(config?.poolConfig);
  }

  /**
   * Discover a peer's Agent Card using the SDK resolver
   */
  async discoverAgentCard(peer: PeerConfig, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const authHandler = createAuthHandler(peer);

    // Get agent from connection pool
    const agent = this.connectionPool.getAgentForUrl(peer.agentCardUrl);

    // Create agent-aware fetch
    const agentAwareFetch = ((url: string, options?: RequestInit) => {
      // @ts-ignore - Node.js fetch accepts agent option
      return fetch(url, { ...options, agent });
    }) as typeof fetch;

    const authFetch = authHandler
      ? createAuthenticatingFetchWithRetry(agentAwareFetch, authHandler)
      : agentAwareFetch;

    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
        transports: [
          new JsonRpcTransportFactory({ fetchImpl: authFetch }),
          new RestTransportFactory({ fetchImpl: authFetch }),
          new GrpcTransportFactory(),
        ],
      })
    );

    await factory.createFromUrl(baseUrl, path);

    const headers: Record<string, string> = authHandler
      ? (await authHandler.headers()) as Record<string, string>
      : {};

    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Agent Card lookup failed with status ${response.status}`);
    }

    return response.json();
  }

  /**
   * Send a message to a peer agent with connection pooling
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

    const doSend = () => this.doSendMessage(peer, message);

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
   * Core send logic with connection pooling
   */
  private async doSendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
  ): Promise<OutboundSendResult> {
    const endpoint = peer.agentCardUrl;
    const connection = await this.connectionPool.acquire(endpoint);

    try {
      const { baseUrl } = parseAgentCardUrl(peer.agentCardUrl);
      const authHandler = createAuthHandler(peer);

      // Get agent from connection pool
      const agent = this.connectionPool.getAgentForUrl(peer.agentCardUrl);

      // Create agent-aware fetch
      const agentAwareFetch = ((url: string, options?: RequestInit) => {
        // @ts-ignore - Node.js fetch accepts agent option
        return fetch(url, { ...options, agent });
      }) as typeof fetch;

      const authFetch = authHandler
        ? createAuthenticatingFetchWithRetry(agentAwareFetch, authHandler)
        : agentAwareFetch;

      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
          transports: [
            new JsonRpcTransportFactory({ fetchImpl: authFetch }),
            new RestTransportFactory({ fetchImpl: authFetch }),
            new GrpcTransportFactory(),
          ],
        })
      );

      const client = await factory.createFromUrl(baseUrl, parseAgentCardUrl(peer.agentCardUrl).path);

      const targetAgentId = typeof (message as any)?.agentId === "string" ? String((message as any).agentId) : "";

      const outboundMessage: any = {
        kind: "message",
        messageId: (message.messageId as string) || uuidv4(),
        role: (message.role as Message["role"]) || "user",
        parts: (message.parts as Message["parts"]) || [
          { kind: "text", text: String(message.text || message.message || "") },
        ],
      };

      if (targetAgentId) {
        outboundMessage.agentId = targetAgentId;
      }

      const sendParams: MessageSendParams = {
        message: outboundMessage,
      };

      const serviceParameters: Record<string, string> = {};
      if (peer.auth?.token) {
        if (peer.auth.type === "bearer") {
          serviceParameters.authorization = `Bearer ${peer.auth.token}`;
        } else {
          serviceParameters["x-api-key"] = peer.auth.token;
        }
      }

      const result = await client.sendMessage(sendParams, {
        serviceParameters: Object.keys(serviceParameters).length ? serviceParameters : undefined,
      });

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
    } finally {
      this.connectionPool.release(connection.id);
    }
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats() {
    return this.connectionPool.getStats();
  }

  /**
   * Destroy connection pool
   */
  destroy(): void {
    this.connectionPool.destroy();
  }
}
