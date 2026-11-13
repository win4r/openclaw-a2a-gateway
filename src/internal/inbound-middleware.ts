/**
 * Inbound `traceparent` HTTP header → AsyncLocalStorage bridge.
 *
 * Used by:
 *  - `index.ts` — installed on the plugin's express app before body
 *    parsing and the A2A SDK handlers
 *  - `scripts/verify-traceparent.mjs` — the standalone end-to-end
 *    verification harness
 *  - Tests in `tests/traceparent-inbound-propagation.test.ts`
 *
 * Lives here (rather than inline in `index.ts`) so the same code path
 * can be exercised by the verification script without loading the whole
 * plugin runtime.  Behaviorally identical to the previous inline copy.
 */

import type { Request, Response, NextFunction } from "express";

import {
  parseTraceparent,
  runWithUpstreamTrace,
  type W3CTraceContext,
} from "./traceparent.js";

/**
 * Express middleware that lifts an inbound `traceparent` HTTP header into
 * the AsyncLocalStorage store so the executor's dispatch can read it.
 *
 * Why we need it: the A2A SDK's express handlers do not expose raw HTTP
 * headers (they only forward `X-A2A-Extensions`), so without this
 * middleware the inbound W3C `traceparent` carrier — which is the
 * canonical propagation channel per the W3C Trace Context Level-1 spec —
 * would be dropped at the SDK boundary.
 *
 * Invalid headers are dropped silently so we never block the request —
 * the executor then mints a fresh root trace of its own.  This matches
 * the "silent fallback" semantics the OpenClaw Gateway itself uses
 * when it sees a malformed carrier.
 */
export function traceparentMiddleware(
  config: { enabled: boolean } = { enabled: true },
): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (!config.enabled) {
      next();
      return;
    }
    const headerValue = req.header("traceparent");
    let parsed: W3CTraceContext | undefined;
    if (typeof headerValue === "string" && headerValue.length > 0) {
      parsed = parseTraceparent(headerValue);
    }
    if (!parsed) {
      next();
      return;
    }
    runWithUpstreamTrace(parsed, () => next());
  };
}
