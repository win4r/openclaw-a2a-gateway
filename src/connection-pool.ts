import http from "node:http";
import https from "node:https";

export interface ConnectionPoolConfig {
  maxConnections?: number;
  maxConnectionsPerEndpoint?: number;
  connectionTtlMs?: number;
}

export interface ConnectionPoolStats {
  activeHttpSockets: number;
  activeHttpsSockets: number;
  idleHttpSockets: number;
  idleHttpsSockets: number;
  pendingHttpRequests: number;
  pendingHttpsRequests: number;
  maxConnections: number;
  maxConnectionsPerEndpoint: number;
  destroyed: boolean;
}

function countSocketEntries(
  table: Record<string, unknown[] | undefined>,
): number {
  return Object.values(table).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

function buildResponseHeaders(
  headers: http.IncomingHttpHeaders,
): HeadersInit {
  const entries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push([key, item]);
      }
      continue;
    }

    if (typeof value === "string") {
      entries.push([key, value]);
    }
  }

  return entries;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Shared keep-alive agents for outbound HTTP requests.
 *
 * The SDK uses fetch-based transports, so pooling is implemented by routing
 * native HTTP requests through long-lived keep-alive agents rather than by
 * creating synthetic "connection" objects in userland.
 */
export class ConnectionPool {
  private readonly maxConnections: number;
  private readonly maxConnectionsPerEndpoint: number;
  private readonly connectionTtlMs: number;
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private destroyed = false;

  constructor(config: ConnectionPoolConfig = {}) {
    this.maxConnections = config.maxConnections ?? 10;
    this.maxConnectionsPerEndpoint = config.maxConnectionsPerEndpoint ?? 3;
    this.connectionTtlMs = config.connectionTtlMs ?? 300_000;

    const agentOptions = {
      keepAlive: true,
      maxSockets: this.maxConnectionsPerEndpoint,
      maxFreeSockets: this.maxConnectionsPerEndpoint,
      maxTotalSockets: this.maxConnections,
      timeout: this.connectionTtlMs,
      scheduling: "lifo" as const,
    };

    this.httpAgent = new http.Agent(agentOptions);
    this.httpsAgent = new https.Agent(agentOptions);
  }

  getAgentForUrl(url: string): http.Agent | https.Agent {
    return new URL(url).protocol === "https:" ? this.httpsAgent : this.httpAgent;
  }

  getStats(): ConnectionPoolStats {
    return {
      activeHttpSockets: countSocketEntries(this.httpAgent.sockets),
      activeHttpsSockets: countSocketEntries(this.httpsAgent.sockets),
      idleHttpSockets: countSocketEntries(this.httpAgent.freeSockets),
      idleHttpsSockets: countSocketEntries(this.httpsAgent.freeSockets),
      pendingHttpRequests: countSocketEntries(this.httpAgent.requests),
      pendingHttpsRequests: countSocketEntries(this.httpsAgent.requests),
      maxConnections: this.maxConnections,
      maxConnectionsPerEndpoint: this.maxConnectionsPerEndpoint,
      destroyed: this.destroyed,
    };
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.destroyed) {
      throw new Error("Connection pool has been destroyed");
    }

    const request = new Request(input, init);
    if (request.signal.aborted) {
      throw abortError();
    }

    const url = new URL(request.url);
    const transport = url.protocol === "https:" ? https : http;
    const body = request.body == null
      ? undefined
      : Buffer.from(await request.arrayBuffer());

    return await new Promise<Response>((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          agent: this.getAgentForUrl(url.toString()),
          signal: request.signal as AbortSignal,
        },
        (res) => {
          const chunks: Buffer[] = [];

          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            resolve(new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
              headers: buildResponseHeaders(res.headers),
            }));
          });
        },
      );

      req.on("error", (error) => {
        if (request.signal.aborted) {
          reject(abortError());
          return;
        }
        reject(error);
      });

      if (body && body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
