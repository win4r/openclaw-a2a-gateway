# W3C `traceparent` propagation

This plugin propagates a W3C Trace Context Level-1
[`traceparent`](https://www.w3.org/TR/trace-context/#traceparent-header)
string across every inbound and outbound path so the A2A gateway, the
OpenClaw IPC WebSocket, and any peer HTTP / gRPC calls end up stitched
into the same distributed trace.

| Where it travels | Field | Length |
|------------------|-------|--------|
| OpenClaw IPC `req` frame on `ws://127.0.0.1:18789` | Top-level `traceparent` | ≤ 128 chars |
| Outbound A2A HTTP (REST + JSON-RPC) | `traceparent` request header | ≤ 128 chars |
| Outbound A2A gRPC | `traceparent` metadata entry | ≤ 128 chars |
| Inbound A2A HTTP (REST + JSON-RPC) | `traceparent` request header | (read into ALS, then propagated downstream) |
| Inbound A2A gRPC | `traceparent` metadata entry | (read into ALS, then propagated downstream) |

All outbound carriers carry **the same value** for a given outbound RPC,
so any tracing UI (Jaeger, Tempo, Honeycomb) renders the A2A bridge as
a single span tree.

---

## End-to-end propagation path

```
Peer A
  │
  │  HTTP POST /a2a/jsonrpc  ── traceparent: 00-TRACE_A-…-01 ──▶
  ▼
Plugin's express middleware
  │  reads traceparent header, parses W3C context,
  │  wraps the rest of the chain in runWithUpstreamTrace(...) →
  ▼
SDK jsonRpcHandler → executor.execute()
  │  pickUpstreamTraceparent() reads from ALS
  │  (falls back to userMessage.metadata.traceparent, then fresh root)
  ▼
OpenClawAgentExecutor.dispatchViaGatewayRpc
  │  buildOutboundTraceparent(upstreamTrace)
  │  → mints fresh child span, same traceId
  ▼
GatewayRpcConnection.request("agent", params, timeout, expectFinal, traceparent)
  │  JSON.stringify({type:"req", id, method, params, traceparent})  // top-level field!
  ▼
OpenClaw Gateway IPC
  │  parses top-level traceparent, creates child diagnostic context
  │  → propagates to agent / harness / model.call / provider / tool / exec spans
  ▼
(if the gateway call triggers a peer hop)
Plugin A2AClient.sendMessage(peer, message, { upstreamTrace })
  │  adds traceparent to serviceParameters → HTTP header (REST/JSON-RPC)
  │                                         → gRPC metadata (gRPC)
  ▼
Peer B (A2A peer)
```

The same ALS scope that stored the upstream trace on the **inbound**
side is the same one the **outbound** peer call picks up via
`getActiveUpstreamTrace()`, so peer→plugin→peer stays on the same
trace.

---

## Where the field is read / written

---

## Where the field is read / written

| Site | What it does | Reference |
|------|--------------|-----------|
| `src/internal/traceparent.ts` | Self-contained W3C utility (format / parse / child / validate) plus the process-global `AsyncLocalStorage` store that bridges inbound headers / metadata into the executor. |  |
| `src/internal/grpc-traceparent.ts` | gRPC server-side interceptor that lifts an inbound `traceparent` metadata entry into the ALS store for every method on the wrapped `A2AServiceServer`. |  |
| `index.ts` (`traceparentMiddleware`) | Express middleware (installed before body parsing) that lifts the inbound `traceparent` HTTP header into the ALS scope for JSON-RPC and REST. |  |
| `index.ts` (gRPC server boot) | `wrapGrpcServiceWithTraceparent(grpcService(...), () => enabled)` wraps every A2A gRPC method with the interceptor. |  |
| `index.ts` (`a2a.send` gateway method, `a2a_send_file` tool) | Pass `upstreamTrace: getActiveUpstreamTrace()` into `client.sendMessage(...)` so peer→plugin→peer stays on the same trace. |  |
| `src/executor.ts` (`GatewayRpcConnection.request`) | Stamps `traceparent` at the **top level** of every `req` frame. Length-checked, malformed values dropped silently per protocol. |  |
| `src/executor.ts` (`dispatchViaGatewayRpc`) | Mints a fresh child span per `agent` and `chat.history` call. Pulls upstream trace from `getActiveUpstreamTrace()` (ALS), then A2A message metadata, then `setTraceparentHooks({ getUpstreamTrace })`. |  |
| `src/executor.ts` (`pickUpstreamTraceparent`) | Resolution order: 1) ALS store (set by inbound middleware / interceptor), 2) `userMessage.metadata.traceparent`, 3) per-part `parts[].metadata.traceparent`. |  |
| `src/client.ts` (`A2AClient.sendMessage` / `doSendMessage`) | Adds `traceparent` to outbound `serviceParameters` (lands as HTTP header for REST + JSON-RPC, gRPC metadata for gRPC). Honors the `upstreamTrace` parameter (typically resolved from ALS). |  |
| `src/internal/envelope.ts` (`w3cToEnvelopeTraceParts`, `envelopeToW3CTraceparent`, `generateEnvelopeTracePair`) | Bridges gateway-internal `trace_id`/`span_id` envelope fields with W3C contexts. |  |
| `src/types.ts` + `index.ts` | Parses `observability.traceparent.enabled` (default `true`). |  |
| `openclaw.plugin.json` | Config schema entry. |  |

---

## Usage

### Inbound (peer → plugin)

A peer calling this plugin's A2A endpoints just sets the standard
`traceparent` HTTP header (or gRPC metadata entry) — no plugin-specific
configuration is required:

```bash
curl -X POST http://gateway.local:18800/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{...}}'
```

The express / gRPC interceptor lifts the header / metadata into a
process-global `AsyncLocalStorage` store.  The executor's dispatch
reads it via `getActiveUpstreamTrace()` and uses it as the parent of
the freshly-minted child span on the IPC `agent` frame.  Outbound peer
calls (`a2a.send` / `a2a_send_file`) inherit the same upstream trace
via `getActiveUpstreamTrace()` — peer→plugin→peer stays on the same
distributed trace without any peer-side changes.

### Outbound (plugin → OpenClaw / peer)

```yaml
observability:
  traceparent:
    enabled: true
```

Every outbound `req` IPC frame carries a fresh child span, and every
outbound A2A peer call (REST/JSON-RPC/gRPC) carries the same value as a
header / metadata entry. No additional setup required.

### Opting an existing OTel / AsyncLocalStorage scope into the propagation

```ts
import { setTraceparentHooks, formatTraceparent } from "./src/internal/traceparent.js";

// 1) Pull from your own OTel/AsyncLocalStorage source
setTraceparentHooks({
  getUpstreamTrace: () => currentTraceContextForActiveRequest(),
});
```

The hook is invoked once per outbound RPC; whatever it returns becomes
the parent of the freshly minted child span. If `undefined` is
returned, the helper mints a brand-new root trace so the wire value is
still well-formed and visible in the trace UI.

### Disable entirely

```yaml
observability:
  traceparent:
    enabled: false
```

Outbound IPC frames and peer calls are sent without a `traceparent`
field. The OpenClaw Gateway will mint its own root trace.

---

## Why not put it in `params`?

`docs/gateway/opentelemetry.md` states that `traceparent` is a **top-level**
field on the `req` frame. The OpenClaw `RequestFrameSchema` enforces
exactly that:

```ts
RequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: NonEmptyString,
  method: NonEmptyString,
  params: Type.Optional(Type.Unknown()),
  traceparent: Type.Optional(Type.String({ maxLength: 128 })),
})
```

Embedding `traceparent` inside `params` would be silently dropped — the
Gateway only consults the top-level field for context attachment. Every
implementation path in this plugin (`agent`, `chat.history`, the
executor, the internal envelope helpers) honors that contract.

---

## Why not `tracestate` / `baggage`?

The same spec page makes it clear:

> `tracestate` and `baggage` fields are NOT supported on `req` frames.
> The Gateway ignores these fields entirely.

This plugin intentionally emits **only** `traceparent`. For richer
carrier data, configure the OpenClaw Provider to inject custom headers
or environment variables on the receiving side.

---

## Per-call child span rule

The OpenClaw Gateway protocol mandates one `traceparent` per RPC:

> Each request, independent injection. The Gateway does not track
> `traceparent` across requests on the same WS connection — callers MUST
> mint a fresh child span for every outbound req, even when the same
> upstream trace is reused.

The helper `createChildTraceparent(parent)` honors this: it inherits the
parent's `traceId` + `traceFlags`, but mints a new `spanId` every call.
See `buildOutboundTraceparent(parent?)` for the high-level entrypoint
used by `executor.ts` and `client.ts`.

---

## Length cap

The schema enforces `maxLength: 128`. Well-formed W3C `traceparent`
values are 55 chars — well below the cap. The helper still validates
length on every output, so over-long or malformed values passed by
higher-level layers are **silently dropped** rather than poisoning the
frame (the Gateway would reject the entire frame outright, hiding
useful logs from downstream tools).

---

## Connect frame note

The Gateway ignores `traceparent` on the initial `connect` handshake
(per `docs/gateway/opentelemetry.md` §"traceparent on the initial
`connect` frame is ignored"). The plugin therefore never stamps
`traceparent` on the connect frame — it always goes out bare, and the
`enabled` / `propagateOnConnect` switches don't change that.

---

## Gateway protocol compatibility — the most important section

The top-level `traceparent` field on `req` frames was added to
`RequestFrameSchema` in **protocol version 5** of the OpenClaw Gateway.
Older Gateway builds (≤2026.3.x in particular) validate frames with
`closedObject`, which strict-rejects unknown top-level keys:

```
invalid request frame: at root: unexpected property 'traceparent'
```

To avoid that, the plugin's `GatewayRpcConnection` keeps a per-connection
`traceparentSupported` flag derived from the **negotiated** protocol
value:

```
negotiated = payload.protocol  // returned by the Gateway's connect response
traceparentSupported = negotiated >= minTraceparentProtocol  // default 5
```

Three things follow from this flag:

1. **Negotiating range**.  During `connect`, the plugin advertises
   `minProtocol: 3, maxProtocol: 5`.  Old Gateways (≤2026.3.x) negotiate
   version 4 or earlier; new ones negotiate version 5.
2. **Per-RPC behavior**.  `request()` only stamps `traceparent` on the
   wire when `traceparentSupported === true`.  When the Gateway
   doesn't advertise `protocol` at all (legacy builds), the field is
   left off by default — no surprise rejections.
3. **Operator override**.  Set
   `observability.traceparent.minProtocolRequired` to a lower number to
   force-enable stamping on older Gateways, or `observability.traceparent.maxProtocol`
   to advertise a higher version once OpenClaw ships one.

### Diagnosing the version mismatch

When this plugin is loaded against a Gateway that runs an older
schema version, you'll see this in the OpenClaw log on every
dispatch:

```
a2a-gateway: agent dispatch failed: invalid request frame: at root:
unexpected property 'traceparent'
```

Confirm the version by running `openclaw config get gateway.port` and
the Gateway's hello-ok message, or check the
`/Users/hemin/.openclaw/logs/openclaw-*.log` file.

### Fix options

| Goal | Configuration |
|------|---------------|
| Make it work on the gateway you have | Upgrade OpenClaw to a build that supports protocol 5+ (≥2026.4.x). After upgrading, no plugin change is needed. |
| Disable propagation entirely on the existing gateway | Set `observability.traceparent.enabled: false` and restart the plugin.  Outbound RPCs proceed, but the trace is lost at the plugin→gateway boundary. |
| Override the gate to allow a custom protocol version | Set `observability.traceparent.maxProtocol: <version>` if your Gateway ships a feature under a higher protocol number (e.g. `maxProtocol: 6`). |

Use `npm run verify:traceparent -- --legacy-gateway` to confirm the
silent-fallback path works against your specific Gateway build before
re-enabling.

---

## Related files

- `src/internal/traceparent.ts` — utility + ALS store
- `src/internal/grpc-traceparent.ts` — gRPC server-side interceptor
- `index.ts` (`traceparentMiddleware`) — express middleware + a2a.send / a2a_send_file wiring
- `src/executor.ts` — IPC dispatch (top-level field) + ALS-aware `pickUpstreamTraceparent`
- `src/client.ts` — peer HTTP / gRPC (header / metadata)
- `src/internal/envelope.ts` — gateway-internal envelope bridge
- `src/types.ts` — `ObservabilityConfigTraceparent`
- `openclaw.plugin.json` — schema entry
- `tests/traceparent.test.ts` — utility unit tests (33 cases)
- `tests/traceparent-propagation.test.ts` — IPC frame integration (7 cases)
- `tests/traceparent-peer-propagation.test.ts` — peer HTTP header integration (7 cases)
- `tests/traceparent-inbound-propagation.test.ts` — end-to-end inbound HTTP/gRPC → ALS → IPC dispatch (7 cases)
