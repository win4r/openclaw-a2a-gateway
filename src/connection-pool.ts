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
  maxConnectionsPerEndpoint?: number;
  connectionTtlMs?: number;
  idleCheckIntervalMs?: number;
}

/**
 * Connection pool for reusing HTTP connections
 */
export class ConnectionPool {
  private pool: Map<string, PooledConnection> = new Map();
  private activeConnections: Set<string> = new Set();
  private waitingQueues: Map<string, Array<(conn: PooledConnection) => void>> = new Map();
  private connectionsByEndpoint: Map<string, Set<string>> = new Map();
  private maxConnections: number;
  private maxConnectionsPerEndpoint: number;
  private connectionTtlMs: number;
  private idleCheckIntervalMs: number;
  private cleanupTimer?: NodeJS.Timeout;
  private isDestroyed: boolean = false;

  constructor(config: ConnectionPoolConfig = {}) {
    this.maxConnections = config.maxConnections ?? 10;
    this.maxConnectionsPerEndpoint = config.maxConnectionsPerEndpoint ?? 3;
    this.connectionTtlMs = config.connectionTtlMs ?? 300000; // 5 minutes
    this.idleCheckIntervalMs = config.idleCheckIntervalMs ?? 60000; // 1 minute
    this.startCleanupTimer();
    this.setupGracefulShutdown();
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

    // 檢查 per-endpoint 限制
    const endpointConnections = this.connectionsByEndpoint.get(endpoint) || new Set();
    if (endpointConnections.size >= this.maxConnectionsPerEndpoint) {
      return this.waitForAvailableConnection(endpoint);
    }

    // 檢查全局連接限制
    if (this.pool.size >= this.maxConnections) {
      return this.waitForAvailableConnection(endpoint);
    }

    // Create new connection if pool is not full
    const connection: PooledConnection = {
      id: uuidv4(),
      endpoint,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true,
    };
    this.pool.set(connection.id, connection);
    this.activeConnections.add(connection.id);

    // 更新 endpoint 連接集合
    const newEndpointConnections = this.connectionsByEndpoint.get(endpoint) || new Set();
    newEndpointConnections.add(connection.id);
    this.connectionsByEndpoint.set(endpoint, newEndpointConnections);

    return connection;
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

      // 檢查是否有等待的請求
      const queue = this.waitingQueues.get(connection.endpoint);
      if (queue && queue.length > 0) {
        const nextResolve = queue.shift();
        if (nextResolve) {
          connection.isActive = true;
          this.activeConnections.add(connectionId);
          connection.lastUsed = Date.now();
          try {
            nextResolve(connection);
          } catch (e) {
            // 忽略錯誤
          }
        }

        // 如果隊列為空，清理
        if (queue.length === 0) {
          this.waitingQueues.delete(connection.endpoint);
        }
      }
    }
  }

  /**
   * Close a connection and remove it from the pool
   * @param connectionId The connection ID to close
   */
  close(connectionId: string): void {
    const connection = this.pool.get(connectionId);
    if (connection) {
      // 從 endpoint 連接集合中移除
      const endpointConnections = this.connectionsByEndpoint.get(connection.endpoint);
      if (endpointConnections) {
        endpointConnections.delete(connectionId);
        if (endpointConnections.size === 0) {
          this.connectionsByEndpoint.delete(connection.endpoint);
        }
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
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // 清理定時器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // 清理所有等待隊列
    this.waitingQueues.forEach((queue) => {
      queue.forEach((resolve) => {
        // 拒絕所有等待的請求
        try {
          const error = new Error("Connection pool destroyed");
          resolve(error as any);
        } catch (e) {
          // 忽略錯誤
        }
      });
    });
    this.waitingQueues.clear();

    // 清理連接池
    this.pool.clear();
    this.activeConnections.clear();
    this.connectionsByEndpoint.clear();

    // 移除事件監聽器
    process.off("beforeExit", () => this.destroy());
    process.off("SIGTERM", () => this.destroy());
    process.off("SIGINT", () => this.destroy());
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    // 監聽進程退出信號
    process.on("beforeExit", () => this.destroy());
    process.on("SIGTERM", () => this.destroy());
    process.on("SIGINT", () => this.destroy());
  }

  /**
   * Wait for an available connection (event-driven)
   */
  private async waitForAvailableConnection(endpoint: string): Promise<PooledConnection> {
    const maxWaitTime = 5000; // 5 seconds
    const startTime = Date.now();

    // 創建 Promise 並加入等待隊列
    return new Promise((resolve, reject) => {
      // 設置超時
      const timeout = setTimeout(() => {
        // 從隊列中移除
        const queue = this.waitingQueues.get(endpoint);
        if (queue) {
          const index = queue.indexOf(resolve as any);
          if (index > -1) {
            queue.splice(index, 1);
          }
        }
        reject(new Error(`Connection pool timeout: no available connection for endpoint ${endpoint}`));
      }, maxWaitTime);

      // 添加到等待隊列
      const queue = this.waitingQueues.get(endpoint) || [];
      queue.push((connection: PooledConnection) => {
        clearTimeout(timeout);
        resolve(connection);
      });
      this.waitingQueues.set(endpoint, queue);
    });
  }
}
