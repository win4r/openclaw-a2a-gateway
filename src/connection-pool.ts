/**
 * Connection Pool for A2A Gateway
 *
 * Provides connection pooling to reduce latency and resource overhead.
 * Reuses HTTP connections across multiple requests, avoiding TCP handshake overhead.
 */

import { v4 as uuidv4 } from "uuid";

/**
 * Represents a pooled HTTP connection
 */
export interface PooledConnection {
  id: string;
  endpoint: string;
  createdAt: number;
  lastUsed: number;
  isActive: boolean;
}

/**
 * Connection pool configuration
 */
export interface ConnectionPoolConfig {
  maxConnections?: number;
  connectionTtlMs?: number;
  idleCheckIntervalMs?: number;
}

/**
 * Connection pool for reusing HTTP connections
 */
export class ConnectionPool {
  private pool: Map<string, PooledConnection> = new Map();
  private activeConnections: Set<string> = new Set();
  private maxConnections: number;
  private connectionTtlMs: number;
  private idleCheckIntervalMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: ConnectionPoolConfig = {}) {
    this.maxConnections = config.maxConnections ?? 10;
    this.connectionTtlMs = config.connectionTtlMs ?? 300000; // 5 minutes
    this.idleCheckIntervalMs = config.idleCheckIntervalMs ?? 60000; // 1 minute
    this.startCleanupTimer();
  }

  /**
   * Acquire a connection from the pool
   * @returns The acquired connection
   */
  async acquire(endpoint: string): Promise<PooledConnection> {
    // Check for available idle connection
    const connectionId = Array.from(this.pool.keys()).find(id => {
      const conn = this.pool.get(id);
      return conn && !this.activeConnections.has(id) && conn.endpoint === endpoint;
    });

    if (connectionId) {
      const connection = this.pool.get(connectionId)!;
      connection.lastUsed = Date.now();
      connection.isActive = true;
      this.activeConnections.add(connectionId);
      return connection;
    }

    // Create new connection if pool is not full
    if (this.pool.size < this.maxConnections) {
      const connection: PooledConnection = {
        id: uuidv4(),
        endpoint,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        isActive: true,
      };
      this.pool.set(connection.id, connection);
      this.activeConnections.add(connection.id);
      return connection;
    }

    // Pool is full, wait for an available connection
    return await this.waitForAvailableConnection(endpoint);
  }

  /**
   * Release a connection back to the pool
   * @param connectionId The connection ID to release
   */
  release(connectionId: string): void {
    const connection = this.pool.get(connectionId);
    if (connection) {
      connection.isActive = false;
      connection.lastUsed = Date.now();
      this.activeConnections.delete(connectionId);
    }
  }

  /**
   * Close a connection and remove it from the pool
   * @param connectionId The connection ID to close
   */
  close(connectionId: string): void {
    this.pool.delete(connectionId);
    this.activeConnections.delete(connectionId);
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalConnections: this.pool.size,
      activeConnections: this.activeConnections.size,
      idleConnections: this.pool.size - this.activeConnections.size,
      maxConnections: this.maxConnections,
    };
  }

  /**
   * Clean up idle and expired connections
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    const expiredConnections: string[] = [];

    for (const [id, connection] of this.pool.entries()) {
      if (!this.activeConnections.has(id)) {
        const idleTime = now - connection.lastUsed;
        const age = now - connection.createdAt;

        // Remove if expired by TTL or older than connection TTL
        if (idleTime > this.connectionTtlMs || age > this.connectionTtlMs) {
          expiredConnections.push(id);
        }
      }
    }

    // Remove expired connections
    for (const id of expiredConnections) {
      this.close(id);
    }
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections();
    }, this.idleCheckIntervalMs);
  }

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.pool.clear();
    this.activeConnections.clear();
  }

  /**
   * Wait for an available connection
   */
  private async waitForAvailableConnection(endpoint: string): Promise<PooledConnection> {
    const maxWaitTime = 5000; // 5 seconds
    const pollInterval = 100; // 100ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check for available connection
      const connectionId = Array.from(this.pool.keys()).find(id => {
        const conn = this.pool.get(id);
        return conn && !this.activeConnections.has(id) && conn.endpoint === endpoint;
      });

      if (connectionId) {
        const connection = this.pool.get(connectionId)!;
        connection.lastUsed = Date.now();
        connection.isActive = true;
        this.activeConnections.add(connection.id);
        return connection;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Connection pool timeout: no available connection for endpoint ${endpoint}`);
  }
}
