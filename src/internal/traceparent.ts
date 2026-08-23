/**
 * W3C Trace Context — `traceparent` propagation for OpenClaw IPC.
 *
 * This is a self-contained, OpenClaw-version-agnostic implementation of the
 * W3C Trace Context Level-1 standard (https://www.w3.org/TR/trace-context/),
 * tailored to how the OpenClaw Gateway recognizes a `traceparent` field on
 * each `req` frame it receives over the local IPC WebSocket.
 *
 * Why this lives in the plugin (and not in @openclaw/gateway-protocol):
 *
 * The installed `openclaw` package on most deployments (e.g. 2026.3.2) does
 * not yet export a public `diagnostic-trace-context.ts` and the
 * `@openclaw/gateway-protocol` / `@openclaw/gateway-client` packages are
 * not listed as plugin dependencies.  The schema field on the Gateway side
 * is documented in `docs/gateway/opentelemetry.md`:
 *
 * ```ts
 * RequestFrameSchema = closedObject({
 *   type: Type.Literal("req"),
 *   id: NonEmptyString,
 *   method: NonEmptyString,
 *   params: Type.Optional(Type.Unknown()),
 *   traceparent: Type.Optional(Type.String({ maxLength: 128 })),
 * })
 * ```
 *
 * Constraints we honor here:
 *  - must be a string, max 128 chars
 *  - top-level field, NOT inside `params`
 *  - lowercase hex (`00-aaaa...-bbbb...-cc`)
 *  - longer values cause the Gateway to reject the frame outright
 *  - malformed values are silently replaced with a fresh trace on the server
 *  - `connect` req (the first handshake) ignores traceparent
 *  - `tracestate` / `baggage` are NOT supported by the Gateway
 *
 * The helper mirrors the shape of
 * `src/infra/diagnostic-trace-context.ts` in the OpenClaw core tree:
 *
 *   formatDiagnosticTraceparent / createChildDiagnosticTraceContext
 *
 * but does NOT require the runtime to expose those names — it generates
 * the W3C string directly.  If OpenClaw ever publishes a public version
 * of the helper, callers can plug it into `setUpstreamTraceHook()` and
 * `setRandomBytesHook()` to replace this implementation without changing
 * call sites.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed W3C trace context.  Mirrors the shape used by OpenClaw's
 * `src/infra/diagnostic-trace-context.ts` so the two can be interchanged
 * at the boundary.
 */
export interface W3CTraceContext {
  /** Always "00" for the current spec version.  Other values are reserved. */
  version: "00";
  /** 16-byte trace id encoded as 32 lowercase hex chars (no dashes, no padding). */
  traceId: string;
  /** 8-byte parent span id encoded as 16 lowercase hex chars. */
  spanId: string;
  /** 1-byte flags.  Right now only bit 0 (sampled) is defined. */
  traceFlags: "00" | "01";
}

/**
 * Optional hooks for cross-runtime integration:
 *  - `getUpstreamTrace` — pulled from the surrounding OTel/async context
 *  - `randomBytes` — pluggable entropy (default: `node:crypto.randomBytes`)
 *
 * The hooks default to "no upstream trace" and `crypto.randomBytes`, which
 * is sufficient for the common case (the plugin is the trace root).
 */
export interface TraceparentOptions {
  /**
   * Pulled by `createChildTraceparent()` when the caller wants to attach
   * to an existing trace instead of starting a new one.  Returning
   * `undefined` means "no upstream trace, mint a fresh one".
   */
  getUpstreamTrace?: () => W3CTraceContext | undefined;
  /**
   * Override randomness — used by tests.  Must produce a Node Buffer of
   * the requested length.
   */
  randomBytes?: (length: number) => Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap from `RequestFrameSchema` (`Type.String({ maxLength: 128 })`).
 * Frames whose `traceparent` value exceeds this length are rejected by the
 * Gateway outright, so we clamp / refuse BEFORE writing to the socket.
 */
export const TRACEPARENT_MAX_LENGTH = 128;

/**
 * The exact length of a well-formed `00-<traceId>-<spanId>-<flags>` string.
 * 2 + 1 + 32 + 1 + 16 + 1 + 2 = 55 chars.
 */
export const TRACEPARENT_WELL_FORMED_LENGTH = 55;

/**
 * 16-byte trace id → 32 hex chars.
 */
export const TRACE_ID_HEX_LENGTH = 32;

/**
 * 8-byte span id → 16 hex chars.
 */
export const SPAN_ID_HEX_LENGTH = 16;

const HEX_RE = /^[0-9a-f]+$/;

/** Lazy, process-global hook registry.  Avoids dragging AsyncLocalStorage in. */
let hookState: TraceparentOptions = {};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Install custom upstream-trace / randomness hooks.  Mostly useful when the
 * OpenClaw runtime exposes its own diagnostic helpers and we want to mirror
 * the trace rather than spawn a new one.
 *
 * Pass an empty object to reset to defaults.
 */
export function setTraceparentHooks(options: TraceparentOptions): void {
  hookState = { ...hookState, ...options };
}

/** Reset the hooks back to defaults (random bytes, no upstream trace). */
export function resetTraceparentHooks(): void {
  hookState = {};
}

/** Read-only snapshot of the active hooks.  Used by tests. */
export function getTraceparentHooks(): Readonly<TraceparentOptions> {
  return hookState;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

/**
 * Lowercase the hex characters in `value`.  Used by `formatTraceparent`
 * to normalize caller-provided upper/mixed-case hex so the output always
 * matches the W3C spec (`all lowercase`).  The W3C spec is strict here:
 * `"00-..."` must be lowercase, and most gateways (including OpenClaw)
 * reject mixed-case input outright.
 *
 * Inputs that contain non-hex characters are returned unchanged so the
 * subsequent length / structural checks surface the error.
 */
function normalizeHex(value: string): string {
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return value;
  }
  return value.toLowerCase();
}

/**
 * Loose validator that returns true iff `value` is a well-formed W3C
 * `traceparent` string under the constraints enforced by `RequestFrameSchema`:
 *  - ASCII string
 *  - ≤ 128 chars (`Type.String({ maxLength: 128 })`)
 *  - `version` field is "00"
 *  - `traceId` is 32 hex chars (case-insensitive) AND is not all-zero
 *  - `spanId`  is 16 hex chars (case-insensitive) AND is not all-zero
 *  - `flags`   is 2 hex chars (case-insensitive)
 *
 * `isValidTraceparent` accepts upper/mixed-case hex here so callers can
 * validate inbound carriers received from libraries that haven't been
 * case-normalized — `formatTraceparent()` always emits lowercase output,
 * so the wire value is canonical.
 *
 * Used internally by `parseTraceparent()` and re-exported for callers that
 * want to gate their own propagation.
 */
export function isValidTraceparent(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > TRACEPARENT_MAX_LENGTH) {
    return false;
  }
  if (value.length !== TRACEPARENT_WELL_FORMED_LENGTH) {
    return false;
  }

  const parts = value.split("-");
  if (parts.length !== 4) {
    return false;
  }
  const [version, traceId, spanId, flags] = parts;

  if (version !== "00") {
    return false;
  }
  if (
    traceId.length !== TRACE_ID_HEX_LENGTH ||
    !/^[0-9a-fA-F]+$/.test(traceId) ||
    /^0+$/.test(normalizeHex(traceId))
  ) {
    return false;
  }
  if (
    spanId.length !== SPAN_ID_HEX_LENGTH ||
    !/^[0-9a-fA-F]+$/.test(spanId) ||
    /^0+$/.test(normalizeHex(spanId))
  ) {
    return false;
  }
  if (flags.length !== 2 || !/^[0-9a-fA-F]+$/.test(flags)) {
    return false;
  }
  return true;
}

/**
 * Strict variant: also requires the W3C version byte.  Use this when you
 * need to be sure the string wasn't truncated.  The returned context
 * always has lowercase hex so downstream comparisons stay canonical.
 */
export function parseTraceparent(value: unknown): W3CTraceContext | undefined {
  if (!isValidTraceparent(value)) {
    return undefined;
  }
  const [, traceId, spanId, flags] = (value as string).split("-");
  return {
    version: "00",
    traceId: normalizeHex(traceId),
    spanId: normalizeHex(spanId),
    traceFlags: flags.toLowerCase() === "01" ? "01" : "00",
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

import { randomBytes as nodeRandomBytes } from "node:crypto";

function resolveRandomBytes(): (length: number) => Uint8Array {
  if (hookState.randomBytes) {
    return hookState.randomBytes;
  }
  return (length: number) => nodeRandomBytes(length);
}

/**
 * Generate a fresh 32-char lowercase hex trace id, refusing "0000…".
 * Used internally by `createTraceparent` / `createChildTraceparent`.
 */
export function generateTraceId(random: (length: number) => Uint8Array = resolveRandomBytes()): string {
  // Loop until we land on a non-zero id; the spec forbids all-zero trace ids.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = random(16);
    const hex = Buffer.from(bytes).toString("hex");
    if (!/^0+$/.test(hex)) {
      return hex;
    }
  }
  throw new Error("could not generate non-zero trace id after 16 attempts");
}

/**
 * Generate a fresh 16-char lowercase hex span id, refusing "0000…".
 */
export function generateSpanId(random: (length: number) => Uint8Array = resolveRandomBytes()): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = random(8);
    const hex = Buffer.from(bytes).toString("hex");
    if (!/^0+$/.test(hex)) {
      return hex;
    }
  }
  throw new Error("could not generate non-zero span id after 16 attempts");
}

/**
 * Mint a brand-new root trace context.  This is the right call when there's
 * no upstream trace to attach to (e.g. an internal cron tick or a heartbeat).
 */
export function createRootTraceparent(random: (length: number) => Uint8Array = resolveRandomBytes()): W3CTraceContext {
  return {
    version: "00",
    traceId: generateTraceId(random),
    spanId: generateSpanId(random),
    traceFlags: "01",
  };
}

/**
 * Mint a child trace context: same trace as the parent, fresh span id.
 *  - When `parent` is provided: reuse parent's traceId + traceFlags,
 *    generate a new spanId so the upstream trace doesn't fork on us.
 *  - When `parent` is `undefined`: fall back to a fresh root.
 *
 * Exactly matches the contract documented for the Gateway in
 * `docs/gateway/opentelemetry.md` §"Each request, independent injection".
 *
 * @example
 *   const upstream = getActiveTraceparent();
 *   const child = createChildTraceparent(upstream);
 *   const tp = formatTraceparent(child);
 *   // → "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
 */
export function createChildTraceparent(
  parent?: W3CTraceContext,
  random: (length: number) => Uint8Array = resolveRandomBytes(),
): W3CTraceContext {
  if (!parent) {
    return createRootTraceparent(random);
  }
  return {
    version: "00",
    traceId: parent.traceId,
    spanId: generateSpanId(random),
    traceFlags: parent.traceFlags === "01" ? "01" : "00",
  };
}

/**
 * Format a `W3CTraceContext` to its spec-compliant 55-char string.
 *
 * All hex is lowercase; any uppercase or mixed-case input is normalized
 * before serializing so the schema's lowercase-only validation passes.
 *
 * Returns `undefined` when the input is malformed — call sites are expected
 * to drop the value (the Gateway will silently fall back to a fresh trace
 * for any invalid input).
 */
export function formatTraceparent(ctx: W3CTraceContext | undefined | null): string | undefined {
  if (!ctx) {
    return undefined;
  }
  if (ctx.version !== "00") {
    return undefined;
  }
  if (
    ctx.traceId.length !== TRACE_ID_HEX_LENGTH ||
    !/^[0-9a-fA-F]+$/.test(ctx.traceId) ||
    /^0+$/.test(normalizeHex(ctx.traceId))
  ) {
    return undefined;
  }
  if (
    ctx.spanId.length !== SPAN_ID_HEX_LENGTH ||
    !/^[0-9a-fA-F]+$/.test(ctx.spanId) ||
    /^0+$/.test(normalizeHex(ctx.spanId))
  ) {
    return undefined;
  }
  if (ctx.traceFlags !== "00" && ctx.traceFlags !== "01") {
    return undefined;
  }

  return `00-${normalizeHex(ctx.traceId)}-${normalizeHex(ctx.spanId)}-${ctx.traceFlags}`;
}

/**
 * Carrier-style helper: produce a `{ traceparent }` object suitable for
 * adding to:
 *
 *   - OpenClaw `req` frames (top level — see `RequestFrameSchema`)
 *   - HTTP request headers for REST/JSON-RPC (header name: `traceparent`)
 *   - gRPC client metadata (metadata key: `traceparent`)
 *
 * Per protocol, length is guaranteed to be 55 chars — well below the 128
 * hard limit — so this helper never needs to truncate.
 */
export function traceparentCarrier(ctx: W3CTraceContext | undefined | null): { traceparent: string } | undefined {
  const tp = formatTraceparent(ctx);
  if (!tp) {
    return undefined;
  }
  return { traceparent: tp };
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage — propagate upstream trace through async boundaries
// ---------------------------------------------------------------------------

import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";

/**
 * Per-async-context snapshot of "the upstream trace, if any".  Used by:
 *
 *   - The inbound express / gRPC middleware in `index.ts`, which lifts a
 *     peer's `traceparent` HTTP header / gRPC metadata into the surrounding
 *     ALS scope so the executor's dispatch can read it without the SDK
 *     having to thread it through `RequestContext`.
 *
 *   - The executor's `pickUpstreamTraceparent`, which falls back to the
 *     ALS store when no explicit upstream is provided.
 *
 *   - Internal callers (`a2a.send` gateway method, `a2a_send_file` tool)
 *     that originate outbound peer calls from inside the same async
 *     context as a peer A2A message, so peer→plugin→peer stays on the
 *     same trace.
 */
export interface UpstreamTraceStore {
  /** Parsed W3C trace context carried by the surrounding async scope, if any. */
  trace: W3CTraceContext | undefined;
}

/**
 * Process-global ALS instance.  Single, lazily-created; mutated only by
 * `runWithUpstreamTrace` below.  Tests that need to read the active store
 * directly can call `getUpstreamTraceStore()`.
 */
const upstreamTraceStore = new NodeAsyncLocalStorage<UpstreamTraceStore>();

/**
 * Run `fn` with the given `trace` available to `getUpstreamTraceFromStore`
 * for the entire async call chain it spawns.  Used by inbound middleware
 * to bridge the inbound `traceparent` header / metadata into the executor.
 */
export function runWithUpstreamTrace<T>(
  trace: W3CTraceContext | undefined,
  fn: () => T,
): T {
  return upstreamTraceStore.run({ trace }, fn);
}

/**
 * Read the active ALS store.  Returns `undefined` when there's no
 * surrounding async scope (e.g. unit-test code calling the helper
 * directly without `runWithUpstreamTrace`).
 */
export function getUpstreamTraceStore(): UpstreamTraceStore | undefined {
  return upstreamTraceStore.getStore();
}

/**
 * Convenience: pull the active upstream trace from the ALS store.
 * Returns `undefined` when there's no surrounding scope.
 */
export function getActiveUpstreamTrace(): W3CTraceContext | undefined {
  return getUpstreamTraceStore()?.trace;
}

// ---------------------------------------------------------------------------
// Upstream-trace resolution (extended)
// ---------------------------------------------------------------------------

/**
 * Walk all upstream-trace sources in priority order and return the first
 * one that yields a `W3CTraceContext`.  Order:
 *  1. explicit `parent` argument (caller-provided)
 *  2. `hookState.getUpstreamTrace` (set via `setTraceparentHooks`)
 *  3. AsyncLocalStorage store (`runWithUpstreamTrace` — used by the
 *     inbound express / gRPC middleware)
 *
 * Used by `withUpstreamTrace` and by the executor / client wrappers below.
 */
export function resolveUpstreamTrace(parent?: W3CTraceContext): W3CTraceContext | undefined {
  if (parent) {
    return parent;
  }
  if (hookState.getUpstreamTrace) {
    const fromHook = hookState.getUpstreamTrace();
    if (fromHook) {
      return fromHook;
    }
  }
  const fromStore = getActiveUpstreamTrace();
  if (fromStore) {
    return fromStore;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Upstream-trace management
// ---------------------------------------------------------------------------

/**
 * Build a per-call traceparent from an optional upstream trace, applying the
 * "child span" rule from `docs/gateway/opentelemetry.md`.  Returns the
 * formatted W3C string when one is successfully built, or `undefined`
 * when the result would be invalid.
 *
 * Callers MUST treat the result as "best effort": if it comes back as
 * `undefined`, fall back to omitting the field entirely.
 */
export function buildOutboundTraceparent(parent?: W3CTraceContext): string | undefined {
  const upstream = resolveUpstreamTrace(parent);
  const child = createChildTraceparent(upstream);
  return formatTraceparent(child);
}

// ---------------------------------------------------------------------------
// Cross-runtime convenience: header normalization
// ---------------------------------------------------------------------------

/**
 * Build a Headers-like record (`Record<string, string>`) carrying the
 * traceparent for an outbound HTTP request.  Always lowercase to satisfy
 * W3C and the Gateway's own validator.  When `ctx` is missing/invalid the
 * result is `undefined` so callers can spread safely.
 */
export function traceparentHeaders(ctx: W3CTraceContext | undefined | null): Record<string, string> | undefined {
  const tp = formatTraceparent(ctx);
  if (!tp) {
    return undefined;
  }
  return { traceparent: tp };
}

/**
 * Same as `traceparentHeaders` but returns a plain array of tuples (gRPC
 * metadata accepts either style).
 */
export function traceparentMetadata(
  ctx: W3CTraceContext | undefined | null,
): Array<[string, string]> | undefined {
  const tp = formatTraceparent(ctx);
  if (!tp) {
    return undefined;
  }
  return [["traceparent", tp]];
}
