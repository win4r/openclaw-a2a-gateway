/**
 * Pooled A2A Client with Connection Pool
 *
 * Extends A2AClient with connection pooling to reduce latency and resource overhead.
 */

import { A2AClient } from "./client.js";
import { ConnectionPool, PooledConnection, ConnectionPoolConfig } from "./connection-pool.js";
import type { PeerConfig, RetryConfig, OutboundSendResult } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";

export class PooledA2AClient extends A2AClient {
  private connectionPool: ConnectionPool;

  constructor(config?: { poolConfig?: ConnectionPoolConfig }) {
    super();
    this.connectionPool = new ConnectionPool(config?.poolConfig);
  }

  /**
   * Send a message with connection pooling
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
      // Call parent method
      const result = await super.sendMessage(peer, message, options);
      return result;
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
   * Destroy connection pool
   */
  destroy(): void {
    this.connectionPool.destroy();
  }
}
