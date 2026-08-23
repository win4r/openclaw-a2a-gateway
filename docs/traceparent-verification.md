# Verifying W3C `traceparent` end-to-end

This plugin propagates a W3C `traceparent` across the entire chain from
a peer A2A request to the OpenClaw agent's internal spans.  If you want
to confirm it actually works against your specific deployment, here are
five verification layers, ordered from "1 minute, no setup" to "real
production observability".  Pick the one that fits your situation.

| Layer | Tool / command | What it proves | Requires |
|-------|----------------|----------------|----------|
| **0.** Static check | `npm run build` | The TypeScript surface compiles cleanly under strict mode. | Node, deps |
| **1.** Unit tests | `npm test -- tests/traceparent*.test.ts` | The `traceparent` utility (`format`, `parse`, `child`, validator) and the inbound HTTP / gRPC end-to-end logic all hold. | Node, deps |
| **2.** In-process verification harness | `npm run verify:traceparent` | All four hops are exercised in one process: peer request → middleware → executor → IPC `agent` frame.  No real OpenClaw needed. | Node, deps |
| **3.** Live curl-based smoke test | one-line curl recipe below | The plugin installed in a real OpenClaw instance propagates a `traceparent` you can observe in the OpenClaw Gateway log. | OpenClaw Gateway running, plugin installed |
| **4.** Live two-A2A-peer chain test | `a2a-send.mjs --traceparent …` against two peers | The full peer → plugin → OpenClaw → plugin → peer chain renders as one trace in your tracing UI. | Two A2A peers, observability backend (Jaeger / Tempo / Honeycomb) |
| **5.** Distributed-trace smoke test | OTel collector + Tracing UI | Visual confirmation that the two-A2A-peer call shows up in Jaeger / Tempo as a single trace tree. | OTel collector, tracing UI |

---

## Layer 2 — In-process verification harness (no deployment needed)

The fastest way to confirm the **entire chain works** without spinning
up an OpenClaw instance: run the bundled harness.  It stands up:

- a mock OpenClaw WebSocket gateway (speaks `connect.challenge` /
  `connect` / `agent`);
- a real `OpenClawAgentExecutor` with the actual `traceparentMiddleware`
  in front of it;
- a real HTTP/JSON-RPC façade.

Then it sends three inbound requests:

1. **With** a `traceparent` HTTP header — verifies the outbound IPC
   `agent` frame inherits the same trace id with a fresh child span.
2. **Without** a `traceparent` header — verifies the dispatcher mints a
   fresh root trace (no scope leak).
3. **With a malformed** `traceparent` — verifies silent fallback.

Run it:

```bash
npm run verify:traceparent
```

Expected output (abridged, *modern* Gateway — i.e. one that responds
with `protocol: 5` in the connect handshake):

```
=== traceparent end-to-end verification ===

mock gateway listening on :<port>
plugin HTTP server    on :<port>

Test 1 — inbound HTTP traceparent → IPC agent frame
  ✔ POST /a2a/jsonrpc returned 200
  ✔ at least one IPC `agent` frame was captured
  ✔ IPC frame carries `traceparent` at the TOP LEVEL
  ✔ traceparent is well-formed per W3C
  ✔ traceparent is NOT inside params
  ✔ traceparent parses to a context
  ✔ outbound trace id INHERITS the inbound upstream trace id
  ✔ outbound span id is FRESH (≠ upstream span id)

Test 2 — absent inbound traceparent → fresh root on the wire
  ✔ second inbound request produced another `agent` frame
  ✔ second frame carries a fresh traceparent
  ✔ second frame's trace id differs from the first (no leak)

Test 3 — malformed inbound traceparent → silent fallback to fresh root
  ✔ malformed inbound still produces a 200 response
  ✔ the dispatch still produced an `agent` frame
  ✔ the dispatcher fell back to a fresh root (well-formed traceparent)

=== PASS ===
```

Useful flags:

```bash
# Use a custom upstream traceparent
npm run verify:traceparent -- --upstream 00-MYTRACE-MYSPAN-01

# Send the inbound request with NO traceparent header (fresh-root path)
npm run verify:traceparent -- --no-upstream

# Test against a *legacy* OpenClaw gateway (≤2026.3.x) — the mock
# returns no `protocol` field, so the plugin's protocol-version gate
# should drop `traceparent` from every outbound frame to avoid the
# real-world "invalid request frame: at root: unexpected property
# 'traceparent'" rejection.  Use this BEFORE upgrading OpenClaw to
# confirm your Gateway won't get surprise-rejected by the plugin.
npm run verify:traceparent -- --legacy-gateway

# Leave the servers running so you can poke at them with curl / websocat
npm run verify:traceparent -- --keep
```

If you run with `--keep`, the harness prints a couple of follow-up
suggestions for poking at the live servers it left up.

> **What the `--legacy-gateway` mode proves.**  OpenClaw Gateway
> builds before the protocol-5 schema additions (e.g. 2026.3.2, which
> is what this repository pulls in by default) reject `req` frames
> carrying a top-level `traceparent` field — the closed-object
> validator returns `invalid request frame: at root: unexpected
> property 'traceparent'`.  The plugin's protocol-version gate
> (`traceparentSupported = negotiatedProtocol >= 5`) prevents that by
> dropping the field for legacy Gateways.  `--legacy-gateway` exercises
> exactly that path: the assertion `LEGACY Gateway: traceparent field
> is DROPPED` confirms the plugin's outbound frames stay clean.

---

## Layer 3 — Live curl-based smoke test (against a real OpenClaw instance)

This is what most operators want to run — it confirms the chain works
against a real OpenClaw Gateway.

### 3.1 — Discover the IPC port

```bash
openclaw config get gateway.port
# 18789
```

### 3.2 — Make sure the plugin is loaded

```bash
openclaw plugins list | grep a2a-gateway
# a2a-gateway  a2a-gateway  1.5.1
```

### 3.3 — Send an A2A `message/send` WITH a `traceparent` header

The agentCard URL is whatever you configured in `agentCard.url`.  In a
default install that's `http://localhost:18800/a2a/jsonrpc`.

```bash
UPSTREAM="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

curl -sS http://localhost:18800/a2a/jsonrpc \
  -H 'Content-Type: application/json' \
  -H "traceparent: ${UPSTREAM}" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"message/send",
    "params":{
      "id":"smoke-1",
      "message":{
        "kind":"message",
        "messageId":"msg-smoke-1",
        "role":"user",
        "parts":[{"kind":"text","text":"verify traceparent propagation"}]
      }
    }
  }'
```

### 3.4 — Verify on the Gateway side

While that request is processing, look at the OpenClaw Gateway log
(the agent's `provider.call` and `exec` spans should land on the same
trace id `4bf92f3577b34da6a3ce929d0e0e4736`):

```bash
# Tail today's gateway log
tail -n 50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log \
  | grep -E "4bf92f3577b34da6a3ce929d0e0e4736"
```

You should see log lines carrying `trace_id=4bf92f3577b34da6a3ce929d0e0e4736`
across `agent`, `harness`, `model.call`, `provider`, `tool.execution`,
`exec` — proving the trace propagated all the way through.

### 3.5 — Verify the WS frame directly (optional, deeper)

If you want byte-level confirmation of the IPC layer, run a temporary
WebSocket dump between the plugin and the Gateway.  OpenClaw ≥ 2026.3.x
has a `gateway.debug` config switch that makes this trivial; otherwise
use `websocat`:

```bash
# Terminal 1 — connect to the Gateway's WebSocket port
websocat ws://127.0.0.1:18789

# You'll see:
#   {"type":"event","event":"connect.challenge","payload":{"nonce":"…"}}
# Forward it as `connect` with your client metadata, then watch the
# `agent` req frame — its top-level `traceparent` field will be the
# child of whatever `traceparent` you sent on the curl request.
```

---

## Layer 4 — Two-peer chain test (peer → plugin → OpenClaw → plugin → peer)

This is the strongest verification.  Two A2A peers call each other
through this plugin — both calls must render as **the same trace**.

### 4.1 — Start an OTel-compatible backend

Easiest: run Grafana Tempo locally with the otel-collector binary
ingesting OTLP.  Or use Jaeger all-in-one with OTLP enabled.

```bash
# Example: jaegertracing/all-in-one
docker run --rm -d --name jaeger \
  -p 16686:16686 -p 4317:4317 -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Or, even simpler with OpenTelemetry Collector Contrib + stdout exporter:
docker run --rm -d --name otel-collector \
  -v $(pwd)/otel-config.yaml:/etc/otelcol/config.yaml \
  -p 4317:4317 -p 4318:4318 \
  otel/opentelemetry-collector-contrib:latest
```

### 4.2 — Configure OpenClaw to send traces to the collector

```yaml
# In your OpenClaw config:
telemetry:
  otlp:
    endpoint: http://localhost:4317
    protocol: grpc
```

### 4.3 — Send a chained A2A message

```bash
# Start the bundled skill script (already on your PATH if you
# `npm link`ed the plugin), with a custom upstream traceparent:
node skill/scripts/a2a-send.mjs \
  --peer-url http://peer-b:18800 \
  --token $PEER_B_TOKEN \
  --traceparent 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01 \
  --message "send this through Peer A → Plugin → OpenClaw → Plugin → Peer B"
```

### 4.4 — Inspect the trace

Open `http://localhost:16686` (Jaeger) or `http://localhost:3000`
(Grafana Tempo) and look up `trace id = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.

You should see one trace tree with:

- **Peer A** (root span, owning the upstream traceparent)
- **A2A plugin** on Server A (a server-side span from the SDK handler)
- **OpenClaw agent** spans inside the Gateway: `agent`, `harness`,
  `model.call`, `provider`, `tool.execution`, `exec`
- **A2A plugin** on Server A making the **outbound peer call** to Peer
  B (HTTP `/a2a/jsonrpc` carrying the same `traceparent` header)
- **Peer B** (a server-side span from its SDK handler)

If `traceparent.enabled` is `true` (default), every step inherits the
trace id.  Anything missing in the middle points at exactly which
implementation path needs attention.

---

## Layer 5 — Production smoke test (post-deploy)

Once you have the plugin installed in production:

1. Pick any live A2A request in your production observability stack.
2. Verify it has a non-empty traceparent at the top level of every IPC
   `agent` req frame on `ws://127.0.0.1:18789`.
3. Verify the trace id propagates through Peer A → Server A → Gateway →
   → Server A → Peer B.

You can run [Layer 0](#0-layer-0--static-check) once per release in CI,
[Layer 2](#layer-2--in-process-verification-harness-no-deployment-needed)
in a smoke-test job on every PR, and [Layer 4](#layer-4--two-peer-chain-test-peer--plugin--openclaw--plugin--peer)
once per major release.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| `IPC frame carries traceparent at the TOP LEVEL` fails | Plugin's `GatewayRpcConnection.request` got an over-long or malformed `traceparent` | The harness drops it silently on purpose; check `observability.traceparent` is not disabled |
| Outbound trace id doesn't match inbound | `observability.traceparent.enabled = false`, OR a custom `setTraceparentHooks({ getUpstreamTrace })` is overriding the ALS | Run `openclaw config get` to confirm the config; remove any test hooks via `setTraceparentHooks({})` |
| `graph shows 2+ traces` in Jaeger / Tempo | The peer → plugin → peer hop isn't picking up the upstream (Layer 4 path) | Confirm `a2a.send` / `a2a_send_file` are passing `upstreamTrace: getActiveUpstreamTrace()` (already wired in `index.ts`); confirm `observability.traceparent.enabled` is `true` on the A2AClient construction in your embed code |
| Custom tracing UI doesn't show traceparent header / metadata | The transport serialization didn't forward `serviceParameters` | Make sure the `client.sendMessage(..., { upstreamTrace })` option is being passed — the SDK's JSON-RPC / REST / gRPC transports all spread `serviceParameters` into headers / metadata |

---

## Files used by this guide

- `scripts/verify-traceparent.mjs` — Layer 2 harness
- `tests/traceparent*.test.ts` — Layer 1 (unit + integration)
- `src/internal/traceparent.ts` — formatter / parser / ALS store
- `src/internal/inbound-middleware.ts` — express middleware (Layer 1/2)
- `src/internal/grpc-traceparent.ts` — gRPC server-side interceptor
- `src/executor.ts` — `pickUpstreamTraceparent` (ALS-first resolution order)
- `src/client.ts` — outbound A2A peer carrier
- `index.ts` — boot wiring (middleware installed + gRPC wrapped + a2a.send / a2a_send_file threading `upstreamTrace`)
- `docs/traceparent.md` — design contract
