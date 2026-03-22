/**
 * Transport fallback helpers for A2A outbound sends.
 *
 * When a peer's Agent Card advertises multiple transports via
 * `additionalInterfaces`, this module provides utilities to order
 * them by priority and to decide whether a send error is retryable
 * at the transport level (as opposed to auth / protocol errors that
 * would fail identically on every transport).
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
