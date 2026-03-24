/**
 * Agent Manager for HTTP Connection Pooling
 *
 * Manages http.Agent and https.Agent instances for connection pooling.
 */

import http from "http";
import https from "https";

/**
 * Agent manager configuration
 */
export interface AgentManagerConfig {
  maxSockets?: number;
  maxFreeSockets?: number;
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  timeout?: number;
  scheduling?: "fifo" | "lifo";
}

/**
 * Agent manager for HTTP connection pooling
 */
export class AgentManager {
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;
  private config: Required<AgentManagerConfig>;

  constructor(config: AgentManagerConfig = {}) {
    this.config = {
      maxSockets: config.maxSockets ?? 10,
      maxFreeSockets: config.maxFreeSockets ?? 5,
      keepAlive: config.keepAlive ?? true,
      keepAliveMsecs: config.keepAliveMsecs ?? 30000,
      timeout: config.timeout ?? 30000,
      scheduling: config.scheduling ?? "fifo",
    };

    // Create HTTP agent
    this.httpAgent = new http.Agent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveMsecs,
      maxSockets: this.config.maxSockets,
      maxFreeSockets: this.config.maxFreeSockets,
      timeout: this.config.timeout,
      scheduling: this.config.scheduling,
    });

    // Create HTTPS agent
    this.httpsAgent = new https.Agent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveMsecs,
      maxSockets: this.config.maxSockets,
      maxFreeSockets: this.config.maxFreeSockets,
      timeout: this.config.timeout,
      scheduling: this.config.scheduling,
    });
  }

  /**
   * Get the appropriate agent for the URL
   */
  getAgent(url: string): http.Agent | https.Agent {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? this.httpsAgent : this.httpAgent;
  }

  /**
   * Create a fetch function with connection pooling
   */
  createPooledFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Determine the URL
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Get the appropriate agent
    const agent = this.getAgent(url);

    // Inject agent into the request
    const options = {
      ...init,
      // @ts-ignore - fetch accepts agent option
      agent,
      // @ts-ignore - fetch accepts httpsAgent option
      httpsAgent: agent,
    };

    return fetch(input, options);
  }

  /**
   * Get HTTP agent
   */
  getHttpAgent(): http.Agent {
    return this.httpAgent;
  }

  /**
   * Get HTTPS agent
   */
  getHttpsAgent(): https.Agent {
    return this.httpsAgent;
  }

  /**
   * Destroy all agents
   */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /**
   * Get agent statistics
   */
  getStats() {
    return {
      http: {
        totalSockets: this.httpAgent.getTotalSockets(),
        freeSockets: this.httpAgent.getFreeSockets(),
        requests: this.httpAgent.requests,
        sockets: this.httpAgent.sockets,
      },
      https: {
        totalSockets: this.httpsAgent.getTotalSockets(),
        freeSockets: this.httpsAgent.getFreeSockets(),
        requests: this.httpsAgent.requests,
        sockets: this.httpsAgent.sockets,
      },
    };
  }
}
