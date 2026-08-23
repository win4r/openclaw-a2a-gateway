/**
 * gRPC server-side interceptor that lifts an inbound `traceparent`
 * metadata entry into the AsyncLocalStorage store so the executor's
 * dispatch can pick it up.
 *
 * Mirrors `traceparentMiddleware` in `index.ts` for the express path;
 * covers the gRPC transport so a peer calling the gateway via gRPC
 * also keeps the same distributed trace across the WS dispatch.
 *
 * gRPC is async-by-construction: each method invocation is a fresh
 * microtask chain started by the gRPC server framework.  Wrapping each
 * method's invocation in `runWithUpstreamTrace` is sufficient because
 * Node's `async_hooks` ties every continuation spawned inside that scope
 * to the same trace store.
 */

import type * as grpc from "@grpc/grpc-js";

import {
  parseTraceparent,
  runWithUpstreamTrace,
  type W3CTraceContext,
} from "./traceparent.js";

/**
 * Pure helper: read & validate the `traceparent` metadata entry on a
 * gRPC server call.  Returns `undefined` when the carrier is missing or
 * malformed so callers can fall through to fresh-root behavior without
 * an extra branch.
 */
export function readTraceparentFromMetadata(
  metadata: grpc.Metadata | undefined,
): W3CTraceContext | undefined {
  if (!metadata) {
    return undefined;
  }
  const values = metadata.get("traceparent");
  if (!values || values.length === 0) {
    return undefined;
  }
  const raw = values[0];
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  return parseTraceparent(raw);
}

type AnyHandler = (...args: any[]) => any;

/**
 * Wrap a single gRPC handler so the rest of its async work runs inside
 * `runWithUpstreamTrace(...)` when the call's metadata carries a
 * `traceparent` entry.  When no carrier is present the handler runs in
 * the ambient scope unchanged, so this is a no-op for ordinary calls.
 *
 * The handler shape follows gRPC's `handleUnaryCall` /
 * `handleServerStreamingCall` convention: `function (call, callback)`.
 * Callbacks receive `(err, value)` so we wrap the callback to surface
 * results back through the surrounding async scope.
 */
export function withTraceparentInterceptor<F extends AnyHandler>(
  handler: F,
  enabled: () => boolean = () => true,
): F {
  if (!enabled()) {
    return handler;
  }
  const wrapped = function (this: unknown, call: any, callback: any) {
    const trace = readTraceparentFromMetadata(call?.metadata);
    if (!trace) {
      return handler.call(this, call, callback);
    }
    return runWithUpstreamTrace(trace, () =>
      handler.call(this, call, callback),
    );
  } as unknown as F;
  return wrapped;
}

/**
 * Wrap a streaming gRPC handler (server-streaming responses).  Same
 * pattern as `withTraceparentInterceptor` but the handler's signature is
 * `(call)` and we only need to wrap the entrypoint — the iteration over
 * the async iterator stays inside the ALS scope automatically.
 */
export function withTraceparentStreamingInterceptor<F extends AnyHandler>(
  handler: F,
  enabled: () => boolean = () => true,
): F {
  if (!enabled()) {
    return handler;
  }
  const wrapped = function (this: unknown, call: any) {
    const trace = readTraceparentFromMetadata(call?.metadata);
    if (!trace) {
      return handler.call(this, call);
    }
    return runWithUpstreamTrace(trace, () =>
      handler.call(this, call),
    );
  } as unknown as F;
  return wrapped;
}

/**
 * Wrap the `A2AServiceServer` returned by the A2A SDK's `grpcService(...)`
 * so that every method lifts `traceparent` into ALS before invoking the
 * underlying handler.
 *
 * The structure of `A2AServiceServer` is fixed at SDK compile time
 * (unary + server-streaming + bidi-streaming methods), so we wrap each
 * method by name.  Names mirror the SDK's interface declarations.
 */
export function wrapGrpcServiceWithTraceparent<T extends Record<string, AnyHandler>>(
  service: T,
  enabled: () => boolean,
): T {
  const wrapped: Record<string, AnyHandler> = {};
  for (const [name, handler] of Object.entries(service)) {
    if (typeof handler !== "function") {
      wrapped[name] = handler as AnyHandler;
      continue;
    }
    // Server-streaming / bidi-streaming handlers have 1 parameter (call).
    // Unary handlers have 2 (call, callback).  We dispatch on arity.
    wrapped[name] = handler.length >= 2
      ? withTraceparentInterceptor(handler, enabled)
      : withTraceparentStreamingInterceptor(handler, enabled);
  }
  return wrapped as T;
}
