/**
 * A2A Gateway — Envelope creation and validation
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 */

import crypto from "node:crypto";
import type {
  A2AEnvelope,
  A2AAck,
  A2AConfig,
  A2ASource,
  A2ADestination,
  MessageType,
} from "./types-internal.js";
import {
  createChildTraceparent,
  type W3CTraceContext,
} from "./traceparent.js";

/**
 * Convenience: split a parsed W3C trace context into the
 * `{ trace_id, span_id }` pair carried on the gateway-internal envelope.
 *
 * The `trace_id`/`span_id` fields on the envelope mirror the
 * `traceparent` carrier: the receiving gateway uses them to stitch the
 * custom-protocol hop back into the upstream OTel trace.  Callers
 * usually want the result of `createChildTraceparent(getActiveTrace())`
 * fed straight into `createEnvelope`'s opts.
 */
export function w3cToEnvelopeTraceParts(
  ctx: W3CTraceContext | undefined,
): { trace_id?: string; span_id?: string } | undefined {
  if (!ctx) {
    return undefined;
  }
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
  };
}

/**
 * Build a child `W3CTraceContext` from a parent envelope's
 * `trace_id`/`span_id`.  Useful at hop boundaries: each hop should
 * generate its own span id so the link between hops shows up clearly
 * in any tracing UI.
 *
 * Returns `undefined` when neither field is present on the parent
 * envelope — call sites can then mint a fresh root trace instead.
 */
export function envelopeToW3CTraceparent(
  envelope: Pick<A2AEnvelope, "trace_id" | "span_id">,
): W3CTraceContext | undefined {
  if (!envelope.trace_id || !envelope.span_id) {
    return undefined;
  }
  // Trust the upstream trace id verbatim — same constraints (32 lowercase
  // hex chars, not all-zero) as W3C.  We don't repackage the upstream
  // span id; the gate creates a child span when entering the next hop.
  return {
    version: "00",
    traceId: envelope.trace_id,
    spanId: envelope.span_id,
    traceFlags: "01",
  };
}

/**
 * Mint a brand-new `(trace_id, span_id)` pair (root trace), returning
 * the same shape as `createEnvelope` expects for its `trace_id` /
 * `span_id` opts.  Equivalent to wrapping the W3C helpers for envelope
 * authoring.  Provided so callers never need to reach into
 * `traceparent.ts` directly.
 */
export function generateEnvelopeTracePair(): { trace_id: string; span_id: string } {
  const ctx = createChildTraceparent();
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
  };
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type EnvelopeErrorCode =
  | "INVALID_VERSION"
  | "MISSING_FIELD"
  | "INVALID_TYPE"
  | "EXPIRED"
  | "LOOP_DETECTED"
  | "HOP_LIMIT"
  | "PAYLOAD_TOO_LARGE";

export interface EnvelopeError {
  code: EnvelopeErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Valid message types
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "command",
  "event",
  "response",
  "error",
  "ack",
]);

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a ULID-like time-ordered unique ID: `{timestamp_hex}-{uuid_last12}` */
export function generateId(): string {
  const timestampHex = Date.now().toString(16);
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const last12 = uuid.slice(-12);
  return `${timestampHex}-${last12}`;
}

// ---------------------------------------------------------------------------
// Envelope factory
// ---------------------------------------------------------------------------

export interface CreateEnvelopeOpts {
  source: A2ASource;
  destination: A2ADestination;
  message_type: MessageType;
  payload: unknown;
  ttl_seconds?: number;
  correlation_id?: string;
  trace_id?: string;
  span_id?: string;
  idempotency_key?: string;
  hop_count?: number;
  route_path?: string[];
}

/** Build a valid A2AEnvelope with sensible defaults. */
export function createEnvelope(opts: CreateEnvelopeOpts): A2AEnvelope {
  return {
    protocol_version: "a2a/v1",
    message_id: generateId(),
    idempotency_key: opts.idempotency_key ?? generateId(),
    correlation_id: opts.correlation_id,
    timestamp: new Date().toISOString(),
    ttl_seconds: opts.ttl_seconds ?? 300,
    trace_id: opts.trace_id,
    span_id: opts.span_id,
    source: opts.source,
    destination: opts.destination,
    message_type: opts.message_type,
    hop_count: opts.hop_count ?? 0,
    route_path: opts.route_path ?? [],
    payload: opts.payload,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate an incoming envelope. Returns null on success or an EnvelopeError. */
export function validateEnvelope(
  envelope: A2AEnvelope,
  config: A2AConfig,
): EnvelopeError | null {
  // Protocol version
  if (envelope.protocol_version !== "a2a/v1") {
    return {
      code: "INVALID_VERSION",
      message: `Unsupported protocol version: ${envelope.protocol_version}`,
    };
  }

  // Required fields
  const requiredFields: Array<{ key: string; value: unknown }> = [
    { key: "message_id", value: envelope.message_id },
    { key: "idempotency_key", value: envelope.idempotency_key },
    { key: "timestamp", value: envelope.timestamp },
    { key: "source.gateway_id", value: envelope.source?.gateway_id },
    { key: "destination", value: envelope.destination },
    { key: "message_type", value: envelope.message_type },
  ];

  for (const { key, value } of requiredFields) {
    if (value === undefined || value === null || value === "") {
      return { code: "MISSING_FIELD", message: `Missing required field: ${key}` };
    }
  }

  // Message type
  if (!VALID_MESSAGE_TYPES.has(envelope.message_type)) {
    return {
      code: "INVALID_TYPE",
      message: `Invalid message_type: ${envelope.message_type}`,
    };
  }

  // Field type validation
  if (
    typeof envelope.ttl_seconds !== "number" ||
    !Number.isFinite(envelope.ttl_seconds) ||
    envelope.ttl_seconds <= 0
  ) {
    return {
      code: "MISSING_FIELD",
      message: "ttl_seconds must be a finite positive number",
    };
  }

  if (
    typeof envelope.hop_count !== "number" ||
    !Number.isFinite(envelope.hop_count) ||
    !Number.isInteger(envelope.hop_count) ||
    envelope.hop_count < 0
  ) {
    return {
      code: "MISSING_FIELD",
      message: "hop_count must be a finite non-negative integer",
    };
  }

  if (
    !Array.isArray(envelope.route_path) ||
    !envelope.route_path.every((p: unknown) => typeof p === "string")
  ) {
    return {
      code: "MISSING_FIELD",
      message: "route_path must be an array of strings",
    };
  }

  // TTL expiry
  const envelopeTime = Date.parse(envelope.timestamp);
  if (isNaN(envelopeTime)) {
    return { code: "MISSING_FIELD", message: "Invalid timestamp format" };
  }
  if (envelopeTime + envelope.ttl_seconds * 1000 <= Date.now()) {
    return { code: "EXPIRED", message: "Envelope TTL has expired" };
  }

  // Anti-loop: reject if our own gateway is already in route_path
  if (envelope.route_path.includes(config.gatewayId)) {
    return {
      code: "LOOP_DETECTED",
      message: `Loop detected: ${config.gatewayId} already in route_path`,
    };
  }

  // Hop limit
  if (envelope.hop_count >= config.limits.maxHops) {
    return {
      code: "HOP_LIMIT",
      message: `Hop count ${envelope.hop_count} exceeds limit ${config.limits.maxHops}`,
    };
  }

  // Payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(envelope.payload), "utf8");
  if (payloadSize > config.limits.maxPayloadBytes) {
    return {
      code: "PAYLOAD_TOO_LARGE",
      message: `Payload size ${payloadSize} exceeds limit ${config.limits.maxPayloadBytes}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ACK creation
// ---------------------------------------------------------------------------

/** Create an A2AAck in response to an envelope. */
export function createAck(
  envelope: A2AEnvelope,
  gatewayId: string,
  status: "accepted" | "rejected",
  reason?: string,
): A2AAck {
  return {
    protocol_version: "a2a/v1",
    message_id: generateId(),
    correlation_id: envelope.message_id,
    source: { gateway_id: gatewayId },
    message_type: "ack",
    timestamp: new Date().toISOString(),
    status,
    reason,
  };
}
