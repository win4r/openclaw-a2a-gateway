/**
 * Connection Pool for A2A Gateway
 *
 * Provides connection pooling to reduce latency and resource overhead.
 * Reuses HTTP connections across multiple requests, avoiding TCP handshake overhead.
 *
 * Key features:
 * - HTTP/HTTPS connection reuse via keep-alive agents
 * - Event-driven queue (no polling)
 * - Per-endpoint connection limits
 * - Graceful shutdown with signal handlers
 */

import http from "node:http";
import https from "node:https";
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
  maxConnectionsPerEndpoint?: number;
  connectionTtlMs?: number;
  idleCheckIntervalMs?: number;
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
}

/**
 * Connection pool for reusing HTTP connections
 */
export class ConnectionPool {
  private pool: Map<string, PooledConnection> = new Map();
  private activeConnections: Set<string> = new Set();
  private connectionsByEndpoint: Map<string, Set<string>> = new Map();
  private waitingQueues: Map<string, Array<(conn: PooledConnection) => void>> = new Map();
  private isDestroyed: boolean = false;

  // Configuration
  private maxConnections: number;
  private maxConnectionsPerEndpoint: number;
  private connectionTtlMs: number;
  private idleCheckIntervalMs: number;

  // HTTP Agents for connection reuse
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;

  // Cleanup timer
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: ConnectionPoolConfig = {}) {
    this.maxConnections = config.maxConnections ?? 10;
    this.maxConnectionsPerEndpoint = config.maxConnectionsPerEndpoint ?? 3;
    this.connectionTtlMs = config.connectionTtlMs ?? 300000; // 5 minutes
    this.idleCheckIntervalMs = config.idleCheckIntervalMs ?? 60000; // 1 minute

    // Create HTTP/HTTPS agents with keep-alive for connection reuse
    this.httpAgent = config.httpAgent ?? new http.Agent({
      keepAlive: true,
      maxSockets: this.maxConnections,
      maxFreeSockets: this.maxConnectionsPerEndpoint,
      timeout: 30000,
    });

    this.httpsAgent = config.httpsAgent ?? new https.Agent({
      keepAlive: true,
      maxSockets: this.maxConnections,
      maxFreeSockets: this.maxConnectionsPerEndpoint,
      timeout: 30000,
    });

    this.startCleanupTimer();
    this.setupSignalHandlers();
  }

  /**
   * Get the appropriate agent for a URL (http or https)
   */
  getAgentForUrl(url: string): http.Agent | https.Agent {
    const protocol = new URL(url).protocol;
    return protocol === "https:" ? this.httpsAgent : this.httpAgent;
  }

  /**
   * Acquire a connection from the pool using event-driven queue
   * @returns The acquired connection
   */
  async acquire(endpoint: string): Promise<PooledConnection> {
    if (this.isDestroyed) {
      throw new Error("Connection pool has been destroyed");
    }

    // Check for available idle connection for this endpoint
    let endpointConnections = this.connectionsByEndpoint.get(endpoint);
    if (!endpointConnections) {
      endpointConnections = new Set();
      this.connectionsByEndpoint.set(endpoint, endpointConnections);
    }

    const availableConnectionId = Array.from(endpointConnections).find(id => {
      const conn = this.pool.get(id);
      return conn && !this.activeConnections.has(id);
    });

    if (availableConnectionId) {
      const connection = this.pool.get(availableConnectionId)!;
      connection.lastUsed = Date.now();
      connection.isActive = true;
      this.activeConnections.add(availableConnectionId);
      return connection;
    }

    // Check per-endpoint limit
    if (endpointConnections.size >= this.maxConnectionsPerEndpoint) {
      // Wait for a connection to become available (event-driven)
      return this.waitForAvailableConnection(endpoint);
    }

    // Check global limit
    if (this.pool.size >= this.maxConnections) {
      // Wait for a connection to become available (event-driven)
      return this.waitForAvailableConnection(endpoint);
    }

    // Create new connection
    const connection: PooledConnection = {
      id: uuidv4(),
      endpoint,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true,
    };

    this.pool.set(connection.id, connection);
    this.activeConnections.add(connection.id);
    this.connectionsByEndpoint.set(endpoint, new Set([...endpointConnections, connection.id]));

    return connection;
  }

  /**
   * Release a connection back to the pool and trigger waiting requests
   * @param connectionId The connection ID to release
   */
  release(connectionId: string): void {
    if (this.isDestroyed) {
      return;
    }

    const connection = this.pool.get(connectionId);
    if (!connection) {
      return;
    }

    connection.isActive = false;
    connection.lastUsed = Date.now();
    this.activeConnections.delete(connectionId);

    // Check if there are waiting requests for this endpoint
    const queue = this.waitingQueues.get(connection.endpoint);
    if (queue && queue.length > 0) {
      // Trigger next waiting request (event-driven, no polling)
      const nextResolve = queue.shift();
      if (nextResolve) {
        this.activeConnections.add(connectionId);
        connection.isActive = true;
        nextResolve(connection);
      }

      // Update queue
      if (queue.length === 0) {
        this.waitingQueues.delete(connection.endpoint);
      } else {
        this.waitingQueues.set(connection.endpoint, queue);
      }
    }
  }

  /**
   * Close a connection and remove it from the pool
   * @param connectionId The connection ID to close
   */
  close(connectionId: string): void {
    const connection = this.pool.get(connectionId);
    if (!connection) {
      return;
    }

    // Remove from endpoint tracking
    const endpointConnections = this.connectionsByEndpoint.get(connection.endpoint);
    if (endpointConnections) {
      endpointConnections.delete(connectionId);
      if (endpointConnections.size === 0) {
        this.connectionsByEndpoint.delete(connection.endpoint);
      } else {
        this.connectionsByEndpoint.set(connection.endpoint, endpointConnections);
      }
    }

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
      waitingRequests: Array.from(this.waitingQueues.values()).reduce((sum, queue) => sum + queue.length, 0),
      httpAgentSockets: (this.httpAgent as any).sockets || {},
      httpsAgentSockets: (this.httpsAgent as any).sockets || {},
    };
  }

  /**
   * Clean up idle and expired connections
   */
  private cleanupIdleConnections(): void {
    if (this.isDestroyed) {
      return;
    }

    const now = Date.now();
    const expiredConnections: string[] = [];

    for (const [id, connection] of this.pool.entries()) {
      if (!this.activeConnections.has(id)) {
        const idleTime = now - connection.lastUsed;
        const age = now - connection.createdAt;

        // Remove if expired by TTL
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
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const cleanup = () => {
      this.destroy();
    };

    process.on("beforeExit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  /**
   * Remove signal handlers
   */
  private removeSignalHandlers(): void {
    const cleanup = () => {
      this.destroy();
    };

    process.off("beforeExit", cleanup);
    process.off("SIGTERM", cleanup);
    process.off("SIGINT", cleanup);
  }

  /**
   * Wait for an available connection using event-driven queue (no polling)
   */
  private async waitForAvailableConnection(endpoint: string): Promise<PooledConnection> {
    return new Promise((resolve) => {
      const queue = this.waitingQueues.get(endpoint) || [];
      queue.push(resolve);
      this.waitingQueues.set(endpoint, queue);
    });
  }

  /**
   * Stop cleanup timer and destroy all resources
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;

    // Remove signal handlers
    this.removeSignalHandlers();

    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Reject all waiting requests
    this.waitingQueues.forEach((queue) => {
      queue.forEach((resolve) => {
        resolve(new Error("Connection pool destroyed") as any);
      });
    });
    this.waitingQueues.clear();

    // Close all connections
    this.pool.clear();
    this.activeConnections.clear();
    this.connectionsByEndpoint.clear();

    // Destroy HTTP agents
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
