/**
 * Pooled A2A Client with Connection Pool
 *
 * Extends A2AClient with connection pooling to reduce latency and resource overhead.
 */

import { A2AClient } from "./client.js";
import { ConnectionPool, PooledConnection, ConnectionPoolConfig } from "./connection-pool.js";
import { AgentManager, AgentManagerConfig } from "./agent-manager.js";
import type { PeerConfig, RetryConfig, OutboundSendResult } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";
import { createAuthHandler, type AuthenticationHandler } from "@a2a-js/sdk/client";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";

export class PooledA2AClient extends A2AClient {
  private connectionPool: ConnectionPool;
  private agentManager: AgentManager;

  constructor(config?: {
    poolConfig?: ConnectionPoolConfig;
    agentConfig?: AgentManagerConfig;
  }) {
    super();
    this.connectionPool = new ConnectionPool(config?.poolConfig);
    this.agentManager = new AgentManager(config?.agentConfig);
  }

  /**
   * Build a ClientFactory with auth-aware fetch and connection pooling
   * Overrides parent method to inject connection pool agents
   */
  private buildFactoryWithPooling(peer: PeerConfig): {
    factory: ClientFactory;
    path: string;
  } {
    const { path } = new URL(peer.agentCardUrl);
    const authHandler = createAuthHandler(peer);

    // Create pooled fetch function
    const pooledFetch = authHandler
      ? createAuthenticatingFetchWithRetry(
          (input: RequestInfo | URL, init?: RequestInit) =>
            this.agentManager.createPooledFetch(input, init),
          authHandler
        )
      : (input: RequestInfo | URL, init?: RequestInit) =>
          this.agentManager.createPooledFetch(input, init);

    // Inject pooled fetch into card resolver and all transports
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: pooledFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: pooledFetch }),
        new RestTransportFactory({ fetchImpl: pooledFetch }),
      ],
    });

    return { factory: new ClientFactory(options), path };
  }

  /**
   * Send a message with connection pooling
   * Overrides parent method to use connection pool and agent manager
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
    // Use connection pool to track connection usage
    const endpoint = peer.agentCardUrl;
    const connection = await this.connectionPool.acquire(endpoint);

    try {
      // Use custom buildFactory with connection pooling
      const { factory, path } = this.buildFactoryWithPooling(peer);
      const { baseUrl } = new URL(peer.agentCardUrl);

      // Create client with pooled connection
      const client = await factory.createFromUrl(baseUrl, path);

      // Extract message parts
      const targetAgentId = typeof (message as any)?.agentId === "string" ? String((message as any).agentId) : "";

      const outboundMessage: any = {
        kind: "message",
        messageId: (message.messageId as string) || crypto.randomUUID(),
        role: (message.role as any) || "user",
        parts: (message.parts as any) || [
          { kind: "text", text: String(message.text || message.message || "") },
        ],
      };

      if (targetAgentId) {
        outboundMessage.agentId = targetAgentId;
      }

      const sendParams: any = {
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

      if (Object.keys(serviceParameters).length > 0) {
        sendParams.serviceParameters = serviceParameters;
      }

      // Send message using SDK client
      const result = await client.sendMessage(sendParams);

      return {
        success: true,
        messageId: result.messageId || outboundMessage.messageId,
        timestamp: Date.now(),
        response: result,
      };
    } finally {
      // Always release connection back to pool
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
   * Get agent manager statistics
   */
  getAgentStats() {
    return this.agentManager.getStats();
  }

  /**
   * Destroy connection pool and agent manager
   */
  destroy(): void {
    this.connectionPool.destroy();
    this.agentManager.destroy();
  }
}
