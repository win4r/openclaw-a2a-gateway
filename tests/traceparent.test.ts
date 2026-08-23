/**
 * traceparent propagation tests.
 *
 * Validates that:
 *  - format / parse roundtrip a W3C traceparent exactly per spec
 *  - length is hard-capped at 128 chars (`RequestFrameSchema` constraint)
 *  - child-of-parent reuses traceId + flags but mints a fresh span id
 *  - bad values are silently dropped (per `docs/gateway/opentelemetry.md`)
 *  - the carrier helpers produce the same shape regardless of transport
 *  - upstream-trace hook installed via `setTraceparentHooks` is honored
 *
 * Run: node --import tsx --test tests/traceparent.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  buildOutboundTraceparent,
  createChildTraceparent,
  createRootTraceparent,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  isValidTraceparent,
  parseTraceparent,
  resetTraceparentHooks,
  setTraceparentHooks,
  traceparentCarrier,
  traceparentHeaders,
  traceparentMetadata,
  TRACEPARENT_MAX_LENGTH,
  TRACEPARENT_WELL_FORMED_LENGTH,
  type W3CTraceContext,
} from "../src/internal/traceparent.js";

afterEach(() => {
  resetTraceparentHooks();
});

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

describe("formatTraceparent", () => {
  it("serializes a canonical context to the 55-char W3C string", () => {
    const ctx: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    assert.equal(
      formatTraceparent(ctx),
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });

  it("normalizes uppercase hex to lowercase", () => {
    const ctx: W3CTraceContext = {
      version: "00",
      traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
      spanId: "00F067AA0BA902B7",
      traceFlags: "01",
    };
    const tp = formatTraceparent(ctx);
    assert.equal(
      tp,
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "uppercase hex must normalize to lowercase",
    );
  });

  it("parses uppercase input back into a lowercase context", () => {
    const parsed = parseTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
    assert.ok(parsed);
    assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(parsed.spanId, "00f067aa0ba902b7");
    assert.equal(parsed.traceFlags, "01");
  });

  it("rejects an all-zero trace id (W3C reserves it as 'invalid')", () => {
    const ctx: W3CTraceContext = {
      version: "00",
      traceId: "00000000000000000000000000000000",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    assert.equal(formatTraceparent(ctx), undefined);
  });

  it("rejects an all-zero span id (W3C reserves it as 'invalid')", () => {
    const ctx: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "0000000000000000",
      traceFlags: "01",
    };
    assert.equal(formatTraceparent(ctx), undefined);
  });

  it("rejects unknown versions", () => {
    const ctx = {
      version: "ff" as unknown as "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    assert.equal(formatTraceparent(ctx), undefined);
  });

  it("rejects unknown trace flags", () => {
    const ctx: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "ff" as unknown as "01",
    };
    assert.equal(formatTraceparent(ctx), undefined);
  });

  it("returns undefined for undefined / null input", () => {
    assert.equal(formatTraceparent(undefined), undefined);
    assert.equal(formatTraceparent(null), undefined);
  });
});

// ---------------------------------------------------------------------------
// Length / validation
// ---------------------------------------------------------------------------

describe("isValidTraceparent", () => {
  it("accepts a canonical 55-char string", () => {
    assert.equal(
      isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
      true,
    );
  });

  it("rejects empty string", () => {
    assert.equal(isValidTraceparent(""), false);
  });

  it("rejects strings longer than the 128-char schema cap", () => {
    const value = "00-" + "a".repeat(130) + "-" + "b".repeat(16) + "-01";
    assert.equal(value.length > TRACEPARENT_MAX_LENGTH, true);
    assert.equal(isValidTraceparent(value), false);
  });

  it("rejects values that are non-string", () => {
    assert.equal(isValidTraceparent(123 as unknown as string), false);
    assert.equal(isValidTraceparent(null as unknown as string), false);
    assert.equal(isValidTraceparent({} as unknown as string), false);
  });

  it("accepts uppercase hex (formatter normalizes to lowercase on output)", () => {
    // Caller-side validators should be case-insensitive; the Gateway
    // silently falls back to a new trace for malformed values, so we'd
    // rather pass through upper/mixed-case input than strip it.
    assert.equal(
      isValidTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"),
      true,
    );
  });

  it("rejects malformed dashes", () => {
    assert.equal(
      isValidTraceparent("00.4bf92f3577b34da6a3ce929d0e0e4736.00f067aa0ba902b7.01"),
      false,
    );
  });

  it("treats the well-formed length as 55", () => {
    assert.equal(TRACEPARENT_WELL_FORMED_LENGTH, 55);
  });
});

describe("parseTraceparent", () => {
  it("roundtrips with formatTraceparent", () => {
    const ctx = createRootTraceparent();
    const string = formatTraceparent(ctx);
    assert.ok(string);
    const parsed = parseTraceparent(string);
    assert.ok(parsed);
    assert.equal(parsed.version, ctx.version);
    assert.equal(parsed.traceId, ctx.traceId);
    assert.equal(parsed.spanId, ctx.spanId);
    assert.equal(parsed.traceFlags, ctx.traceFlags);
  });

  it("returns undefined for invalid input (never throws)", () => {
    assert.equal(parseTraceparent("not a trace"), undefined);
    assert.equal(parseTraceparent(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Generator + child rule
// ---------------------------------------------------------------------------

describe("createRootTraceparent / createChildTraceparent", () => {
  it("creates 32-hex trace ids and 16-hex span ids", () => {
    const root = createRootTraceparent();
    assert.equal(root.traceId.length, 32);
    assert.equal(root.spanId.length, 16);
    assert.match(root.traceId, /^[0-9a-f]+$/);
    assert.match(root.spanId, /^[0-9a-f]+$/);
  });

  it("child reuses parent traceId + flags but mints a fresh spanId", () => {
    const parent: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const child = createChildTraceparent(parent);
    assert.equal(child.traceId, parent.traceId, "child must inherit traceId");
    assert.notEqual(child.spanId, parent.spanId, "child MUST have its own spanId");
    assert.equal(child.traceFlags, parent.traceFlags);
  });

  it("child of '00' flags stays '00' (preserves un-sampled upstream)", () => {
    const parent: W3CTraceContext = {
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "00",
    };
    const child = createChildTraceparent(parent);
    assert.equal(child.traceFlags, "00");
  });

  it("falls back to a fresh root when no parent is provided", () => {
    const a = createChildTraceparent();
    const b = createChildTraceparent();
    assert.notEqual(a.traceId, b.traceId, "root trace ids should differ across calls");
  });

  it("never returns an all-zero id", () => {
    // Run a small number of trials — the all-zero retry loop is exercised.
    for (let i = 0; i < 50; i += 1) {
      const ctx = createRootTraceparent();
      assert.notEqual(ctx.traceId, "0".repeat(32));
      assert.notEqual(ctx.spanId, "0".repeat(16));
    }
  });

  it("respects a custom randomBytes hook (deterministic test mode)", () => {
    let counter = 0;
    setTraceparentHooks({
      randomBytes: (length: number) => {
        const out = new Uint8Array(length);
        // Sequential bytes 0x01, 0x02, ... — never zero, never collides across runs
        for (let i = 0; i < length; i += 1) {
          out[i] = ((counter += 1) + 0x10) & 0xff;
        }
        return out;
      },
    });
    const ctx = createRootTraceparent();
    // trace id (16 bytes) → 32 hex chars, span id (8 bytes) → 16 hex chars
    assert.equal(ctx.traceId.length, 32);
    assert.match(ctx.traceId, /^[0-9a-f]+$/);
    assert.notEqual(ctx.traceId, "0".repeat(32));
    assert.equal(ctx.spanId.length, 16);
    assert.match(ctx.spanId, /^[0-9a-f]+$/);
    assert.notEqual(ctx.spanId, "0".repeat(16));
  });
});

describe("generateTraceId / generateSpanId", () => {
  it("reuses the active random hook", () => {
    let counter = 0;
    setTraceparentHooks({
      randomBytes: (length: number) => {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) {
          out[i] = ((counter += 1) + 0x10) & 0xff;
        }
        return out;
      },
    });
    const tid = generateTraceId();
    assert.equal(tid.length, 32);
    const sid = generateSpanId();
    assert.equal(sid.length, 16);
  });
});

// ---------------------------------------------------------------------------
// Upstream-trace hook
// ---------------------------------------------------------------------------

describe("buildOutboundTraceparent + setTraceparentHooks", () => {
  it("uses the hook when no parent is provided", () => {
    setTraceparentHooks({
      getUpstreamTrace: () => ({
        version: "00",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      }),
    });
    const tp = buildOutboundTraceparent();
    assert.ok(tp);
    const parsed = parseTraceparent(tp);
    assert.ok(parsed);
    assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.notEqual(parsed.spanId, "00f067aa0ba902b7", "must always mint fresh span id");
  });

  it("argument beats hook", () => {
    setTraceparentHooks({
      getUpstreamTrace: () => ({
        version: "00",
        traceId: "11111111111111111111111111111111",
        spanId: "1111111111111111",
        traceFlags: "01",
      }),
    });
    const tp = buildOutboundTraceparent({
      version: "00",
      traceId: "22222222222222222222222222222222",
      spanId: "2222222222222222",
      traceFlags: "01",
    });
    assert.ok(tp);
    const parsed = parseTraceparent(tp);
    assert.equal(parsed.traceId, "22222222222222222222222222222222");
  });

  it("falls back to fresh root when neither parent nor hook is set", () => {
    const tp = buildOutboundTraceparent();
    assert.ok(tp);
    assert.equal(tp.length, TRACEPARENT_WELL_FORMED_LENGTH);
  });

  it("hooks are reset by resetTraceparentHooks", () => {
    setTraceparentHooks({
      getUpstreamTrace: () => ({
        version: "00",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      }),
    });
    resetTraceparentHooks();
    const a = buildOutboundTraceparent();
    const b = buildOutboundTraceparent();
    // Without the hook, each call mints a fresh root trace.
    const parsedA = parseTraceparent(a);
    const parsedB = parseTraceparent(b);
    assert.notEqual(parsedA?.traceId, parsedB?.traceId);
  });
});

// ---------------------------------------------------------------------------
// Carrier helpers
// ---------------------------------------------------------------------------

describe("traceparentCarrier / traceparentHeaders / traceparentMetadata", () => {
  const ctx: W3CTraceContext = {
    version: "00",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  };

  it("traceparentCarrier returns a top-level field object", () => {
    const carrier = traceparentCarrier(ctx);
    assert.ok(carrier);
    assert.equal(carrier.traceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    // Only one field; no extra baggage/tracestate (per docs/gateway/opentelemetry.md)
    assert.deepEqual(Object.keys(carrier).sort(), ["traceparent"]);
  });

  it("traceparentHeaders returns a single lowercase header", () => {
    const hdrs = traceparentHeaders(ctx);
    assert.ok(hdrs);
    assert.equal(hdrs.traceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    // No baggage, no tracestate.
    assert.deepEqual(Object.keys(hdrs).sort(), ["traceparent"]);
  });

  it("traceparentMetadata returns a single tuple pair", () => {
    const md = traceparentMetadata(ctx);
    assert.ok(md);
    assert.equal(md.length, 1);
    const [k, v] = md[0];
    assert.equal(k, "traceparent");
    assert.equal(v, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  it("all three helpers return undefined for missing / invalid contexts", () => {
    assert.equal(traceparentCarrier(undefined), undefined);
    assert.equal(traceparentCarrier(null), undefined);
    assert.equal(traceparentHeaders(undefined), undefined);
    assert.equal(traceparentMetadata(undefined), undefined);
  });

  it("length never exceeds 128 chars (RequestFrameSchema cap)", () => {
    for (let i = 0; i < 100; i += 1) {
      const random = createRootTraceparent();
      const tp = formatTraceparent(random);
      assert.ok(tp);
      assert.ok(
        tp.length <= TRACEPARENT_MAX_LENGTH,
        `produced traceparent of ${tp.length} chars, must be ≤ ${TRACEPARENT_MAX_LENGTH}`,
      );
    }
  });
});
