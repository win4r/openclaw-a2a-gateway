/**
 * DNS-based dynamic agent discovery using DNS-SD (SRV + TXT records).
 *
 * Allows A2A gateways to discover peers on the local network automatically
 * instead of requiring hardcoded peer URLs in config.
 *
 * Uses Node.js built-in `dns.promises` module only -- no external mDNS packages.
 * For `.local` domains, a local DNS resolver (Avahi/Bonjour) must be configured.
 */

import dns from "node:dns";

import type { PeerConfig, PeerAuthConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
  agentCardUrl: string;
  /** Transport protocol advertised in TXT record (default: "jsonrpc"). */
  protocol?: string;
  /** Auth info from TXT record, if provided. */
  auth?: { type: string; token: string };
  /** Timestamp (ms) when this peer was discovered. */
  discoveredAt: number;
  /** DNS TTL in seconds (from SRV record, or fallback). */
  ttl: number;
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

export type DiscoveryLogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  details?: Record<string, unknown>,
) => void;

// ---------------------------------------------------------------------------
// TXT record parsing
// ---------------------------------------------------------------------------

/**
 * Parse DNS TXT record chunks into a key-value map.
 *
 * DNS TXT records come back as `string[][]` from Node -- each record is an
 * array of strings (chunks). Chunks are key=value pairs like:
 *   `"protocol=jsonrpc" "name=MyAgent" "path=/custom/agent-card.json"`
 */
export function parseTxtRecords(
  records: string[][],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const chunks of records) {
    for (const chunk of chunks) {
      const eqIdx = chunk.indexOf("=");
      if (eqIdx > 0) {
        const key = chunk.slice(0, eqIdx).trim().toLowerCase();
        const value = chunk.slice(eqIdx + 1).trim();
        result.set(key, value);
      }
    }
  }
  return result;
}

/**
 * Build an agentCardUrl from SRV host, port, and optional path from TXT.
 */
export function buildAgentCardUrl(
  host: string,
  port: number,
  pathFromTxt?: string,
): string {
  const cardPath = pathFromTxt || "/.well-known/agent-card.json";
  const normalizedPath = cardPath.startsWith("/") ? cardPath : `/${cardPath}`;
  return `http://${host}:${port}${normalizedPath}`;
}

/**
 * Merge static peers with discovered peers. Static peers take precedence
 * on name collision (explicit config wins over discovery).
 */
export function mergeWithStaticPeers(
  staticPeers: PeerConfig[],
  discoveredPeers: DiscoveredPeer[],
): PeerConfig[] {
  const staticNames = new Set(staticPeers.map((p) => p.name));
  const merged = [...staticPeers];

  for (const discovered of discoveredPeers) {
    if (!staticNames.has(discovered.name)) {
      merged.push(discoveredPeerToConfig(discovered));
    }
  }

  return merged;
}

/**
 * Convert a DiscoveredPeer into the standard PeerConfig format.
 */
export function discoveredPeerToConfig(peer: DiscoveredPeer): PeerConfig {
  const config: PeerConfig = {
    name: peer.name,
    agentCardUrl: peer.agentCardUrl,
  };

  if (peer.auth?.type && peer.auth?.token) {
    const authType = peer.auth.type === "bearer" || peer.auth.type === "apiKey"
      ? peer.auth.type
      : "bearer";
    config.auth = { type: authType, token: peer.auth.token } as PeerAuthConfig;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Discovery Manager
// ---------------------------------------------------------------------------

export class DnsDiscoveryManager {
  private readonly config: DnsDiscoveryConfig;
  private readonly log: DiscoveryLogFn;
  private discoveredPeers: DiscoveredPeer[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: DnsDiscoveryConfig, log: DiscoveryLogFn) {
    this.config = config;
    this.log = log;
  }

  /** Begin periodic DNS-SD discovery. */
  start(): void {
    if (!this.config.enabled || this.running) return;
    this.running = true;

    this.log("info", "dns-discovery.start", {
      serviceName: this.config.serviceName,
      refreshIntervalMs: this.config.refreshIntervalMs,
    });

    // Run immediately, then on interval
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.refreshIntervalMs);
  }

  /** Stop periodic discovery and clear cached peers. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const cleared = this.discoveredPeers.length;
    this.discoveredPeers = [];
    this.running = false;
    this.log("info", "dns-discovery.stop", {
      peersCleared: cleared,
    });
  }

  /** Get current list of discovered peers (may include expired entries until next refresh). */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return [...this.discoveredPeers];
  }

  /** Convert discovered peers to standard PeerConfig format. */
  toPeerConfigs(): PeerConfig[] {
    return this.discoveredPeers.map(discoveredPeerToConfig);
  }

  /** Find a discovered peer by name. */
  findPeer(name: string): DiscoveredPeer | undefined {
    return this.discoveredPeers.find((p) => p.name === name);
  }

  /**
   * Run a single discovery cycle.
   *
   * Queries SRV records for the configured service name, then resolves TXT
   * records for metadata. On failure, retains last known peers and logs a warning.
   */
  private refresh(): void {
    this.discover().catch((err) => {
      // Always evict expired peers even when DNS fails
      this.evictExpired();
      this.log("warn", "dns-discovery.refresh-failed", {
        error: err instanceof Error ? err.message : String(err),
        retainedPeers: this.discoveredPeers.length,
      });
    });
  }

  private async discover(): Promise<void> {
    const serviceName = this.config.serviceName;
    let srvRecords: dns.SrvRecord[];

    try {
      srvRecords = await dns.promises.resolveSrv(serviceName);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ENODATA / ENOTFOUND are expected when no services are registered
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "ESERVFAIL") {
        this.log("info", "dns-discovery.no-srv-records", {
          serviceName,
          code,
        });
        // Remove expired peers but don't crash
        this.evictExpired();
        return;
      }
      throw err;
    }

    // Query TXT records for metadata (best-effort, may fail)
    let txtMap = new Map<string, string>();
    try {
      const txtRecords = await dns.promises.resolveTxt(serviceName);
      txtMap = parseTxtRecords(txtRecords);
    } catch {
      // TXT records are optional; continue with defaults
      this.log("info", "dns-discovery.no-txt-records", { serviceName });
    }

    const now = Date.now();
    const protocol = txtMap.get("protocol") || "jsonrpc";
    const pathFromTxt = txtMap.get("path");
    const authType = txtMap.get("auth_type") || "";
    const authToken = txtMap.get("auth_token") || "";

    const newPeers: DiscoveredPeer[] = [];
    for (const srv of srvRecords) {
      const peerName = txtMap.get("name") || srv.name.split(".")[0] || `${srv.name}`;
      const agentCardUrl = buildAgentCardUrl(srv.name, srv.port, pathFromTxt);
      const ttl = (srv as any).ttl ?? 300; // Node dns module may not expose TTL; default 5min

      const peer: DiscoveredPeer = {
        name: peerName,
        host: srv.name,
        port: srv.port,
        agentCardUrl,
        protocol,
        discoveredAt: now,
        ttl,
      };

      if (authType && authToken) {
        peer.auth = { type: authType, token: authToken };
      }

      newPeers.push(peer);
    }

    // Update cached peers: merge new with existing (retain those not yet expired)
    const existingByKey = new Map(
      this.discoveredPeers.map((p) => [`${p.host}:${p.port}`, p]),
    );

    for (const newPeer of newPeers) {
      existingByKey.set(`${newPeer.host}:${newPeer.port}`, newPeer);
    }

    // Evict expired entries
    const allPeers = [...existingByKey.values()];
    this.discoveredPeers = allPeers.filter(
      (p) => now - p.discoveredAt < p.ttl * 1000,
    );

    this.log("info", "dns-discovery.refreshed", {
      serviceName,
      srvCount: srvRecords.length,
      activePeers: this.discoveredPeers.length,
      peerNames: this.discoveredPeers.map((p) => p.name),
    });
  }

  /** Remove peers whose TTL has expired. */
  private evictExpired(): void {
    const now = Date.now();
    const before = this.discoveredPeers.length;
    this.discoveredPeers = this.discoveredPeers.filter(
      (p) => now - p.discoveredAt < p.ttl * 1000,
    );
    if (this.discoveredPeers.length < before) {
      this.log("info", "dns-discovery.evicted-expired", {
        evicted: before - this.discoveredPeers.length,
        remaining: this.discoveredPeers.length,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Config parsing helpers
// ---------------------------------------------------------------------------

export const DNS_DISCOVERY_DEFAULTS: DnsDiscoveryConfig = {
  enabled: false,
  serviceName: "_a2a._tcp.local",
  refreshIntervalMs: 30_000,
  mergeWithStatic: true,
};

export function parseDnsDiscoveryConfig(
  raw: Record<string, unknown> | undefined,
): DnsDiscoveryConfig {
  if (!raw) return { ...DNS_DISCOVERY_DEFAULTS };

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DNS_DISCOVERY_DEFAULTS.enabled,
    serviceName: typeof raw.serviceName === "string" && raw.serviceName.trim()
      ? raw.serviceName.trim()
      : DNS_DISCOVERY_DEFAULTS.serviceName,
    refreshIntervalMs:
      typeof raw.refreshIntervalMs === "number" && Number.isFinite(raw.refreshIntervalMs) && raw.refreshIntervalMs >= 1000
        ? raw.refreshIntervalMs
        : DNS_DISCOVERY_DEFAULTS.refreshIntervalMs,
    mergeWithStatic: typeof raw.mergeWithStatic === "boolean"
      ? raw.mergeWithStatic
      : DNS_DISCOVERY_DEFAULTS.mergeWithStatic,
  };
}
