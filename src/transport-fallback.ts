/**
 * Transport fallback helpers for A2A outbound sends.
 *
 * When a peer's Agent Card advertises multiple transports via
 * `additionalInterfaces`, this module provides utilities to order
 * them by priority and to decide whether a send error is retryable
 * at the transport level (as opposed to auth / protocol errors that
 * would fail identically on every transport).
 *
 * Adaptive transport selection (Phase 2.2): inspired by cellular signal
 * pathway selection, where cells activate different signaling cascades
 * (cAMP, Ca²⁺, MAPK) depending on recent efficacy and response speed.
 * {@link TransportStats} tracks per-transport success rates and latency,
 * and {@link adaptiveOrderTransports} ranks transports by a composite
 * score analogous to pathway signal strength.
 *
 * @see Kholodenko, B.N. (2006) "Cell-signalling dynamics in time and
 *   space." Nat Rev Mol Cell Biol 7:165-176.
 */

// ---------------------------------------------------------------------------
// Transport priority
// ---------------------------------------------------------------------------

/** Canonical transport protocol names from the A2A v0.3.0 spec. */
export type TransportPriority = "JSONRPC" | "HTTP+JSON" | "GRPC";

/** Fallback order: JSON-RPC first, REST second, gRPC last. */
const PRIORITY_ORDER: readonly string[] = ["JSONRPC", "HTTP+JSON", "GRPC"];

export interface TransportEndpoint {
  url: string;
  transport: string;
}

/**
 * Sort transport endpoints by priority (JSON-RPC > REST > gRPC).
 * Unknown transports are appended at the end in their original order.
 */
export function orderTransports(interfaces: TransportEndpoint[]): TransportEndpoint[] {
  const known: TransportEndpoint[] = [];
  const unknown: TransportEndpoint[] = [];

  // Bucket by known vs unknown
  for (const iface of interfaces) {
    if (PRIORITY_ORDER.includes(iface.transport)) {
      known.push(iface);
    } else {
      unknown.push(iface);
    }
  }

  // Sort known by priority index
  known.sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.transport) - PRIORITY_ORDER.indexOf(b.transport),
  );

  return [...known, ...unknown];
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the error indicates a transport-level problem that
 * could succeed on a different transport (connection refused, timeout, 5xx).
 *
 * Auth errors (401/403) and A2A protocol errors are NOT retryable because
 * they would fail identically on every transport.
 */
export function isRetryableTransportError(error: unknown): boolean {
  if (!error) return false;

  // Fetch / network errors thrown as Error objects
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("epipe") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket") ||
      msg.includes("abort") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("dns") ||
      msg.includes("enotfound") ||
      // gRPC transport errors
      msg.includes("unavailable") ||
      msg.includes("deadline exceeded")
    );
  }

  // HTTP response-like objects with a status code
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as any).statusCode === "number"
  ) {
    const code = (error as any).statusCode as number;
    // 5xx = server error → could be transport-specific → retry
    // 429 = rate limit → transport-specific → retry
    if (code >= 500 || code === 429) return true;
    // 401/403 = auth → would fail on all transports → no retry
    // Other 4xx = client error → no retry
    return false;
  }

  // Unknown shape → not retryable (be conservative)
  return false;
}

// ---------------------------------------------------------------------------
// Adaptive transport selection — signal pathway analogy
// ---------------------------------------------------------------------------

/** A single transport outcome record. */
export interface TransportRecord {
  ok: boolean;
  latencyMs: number;
  timestamp: number;
}

/**
 * Latency normalization constant (ms).  When average latency equals this
 * value, the latency factor is 0.5.  Analogous to the Km in
 * Michaelis-Menten: half-maximal response at this "concentration".
 * @default 1000
 */
const DEFAULT_LATENCY_NORMALIZER = 1000;

/**
 * Tracks per-transport success rates and latencies within a sliding window.
 *
 * Inspired by how cells monitor pathway efficacy: each signaling cascade
 * has an implicit "success rate" (fraction of signals that reach the
 * nucleus) and a "latency" (time from receptor activation to gene
 * expression).  Pathways with higher efficacy and lower latency are
 * preferentially activated.
 *
 * @see Kholodenko, B.N. (2006) Nat Rev Mol Cell Biol 7:165-176.
 */
export class TransportStats {
  private readonly windowSize: number;
  private readonly latencyNormalizer: number;
  private readonly records = new Map<string, TransportRecord[]>();

  constructor(windowSize = 20, latencyNormalizer = DEFAULT_LATENCY_NORMALIZER) {
    this.windowSize = Math.max(1, windowSize);
    this.latencyNormalizer = Math.max(1, latencyNormalizer);
  }

  /** Record a transport attempt outcome. */
  record(transport: string, ok: boolean, latencyMs: number): void {
    let list = this.records.get(transport);
    if (!list) {
      list = [];
      this.records.set(transport, list);
    }
    list.push({ ok, latencyMs: Math.max(0, latencyMs), timestamp: Date.now() });
    // Trim to sliding window
    if (list.length > this.windowSize) {
      list.splice(0, list.length - this.windowSize);
    }
  }

  /**
   * Success rate in [0, 1] for a transport.
   * Returns 1 if no records exist (optimistic default for untested transports).
   */
  successRate(transport: string): number {
    const list = this.records.get(transport);
    if (!list || list.length === 0) return 1;
    const successes = list.filter((r) => r.ok).length;
    return successes / list.length;
  }

  /**
   * Average latency (ms) of successful calls.
   * Returns 0 if no successful records (treat as unknown, not penalized).
   */
  avgLatency(transport: string): number {
    const list = this.records.get(transport);
    if (!list) return 0;
    const okRecords = list.filter((r) => r.ok);
    if (okRecords.length === 0) return 0;
    return okRecords.reduce((sum, r) => sum + r.latencyMs, 0) / okRecords.length;
  }

  /**
   * Composite score for adaptive transport ordering.
   *
   *   score = successRate × latencyFactor
   *   latencyFactor = 1 / (1 + avgLatency / normalizer)
   *
   * Analogous to signal pathway strength: higher efficacy (success rate)
   * and faster transduction (lower latency) yield stronger pathway
   * activation.  Unknown transports score 1.0 (explore-first).
   */
  getScore(transport: string): number {
    const sr = this.successRate(transport);
    const avg = this.avgLatency(transport);
    const latencyFactor = 1 / (1 + avg / this.latencyNormalizer);
    return sr * latencyFactor;
  }

  /** Number of recorded outcomes for a transport. */
  count(transport: string): number {
    return this.records.get(transport)?.length ?? 0;
  }

  /** Clear all records. */
  clear(): void {
    this.records.clear();
  }
}

/**
 * Order transports by adaptive score (highest first).
 *
 * Uses {@link TransportStats} to rank transports by recent performance.
 * Ties are broken by static priority (JSONRPC > HTTP+JSON > GRPC).
 * Unknown transports (no stats) get the optimistic default score of 1.0,
 * encouraging exploration of untested pathways.
 *
 * Without stats, the result is identical to {@link orderTransports}
 * (backward-compatible).
 */
export function adaptiveOrderTransports(
  interfaces: TransportEndpoint[],
  stats: TransportStats,
): TransportEndpoint[] {
  return [...interfaces].sort((a, b) => {
    const scoreA = stats.getScore(a.transport);
    const scoreB = stats.getScore(b.transport);
    if (scoreA !== scoreB) return scoreB - scoreA; // Higher score first

    // Tie-break: static priority
    const prioA = PRIORITY_ORDER.indexOf(a.transport);
    const prioB = PRIORITY_ORDER.indexOf(b.transport);
    const idxA = prioA === -1 ? PRIORITY_ORDER.length : prioA;
    const idxB = prioB === -1 ? PRIORITY_ORDER.length : prioB;
    return idxA - idxB;
  });
}
