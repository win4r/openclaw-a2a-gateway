# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **OpenClaw ≤2026.3.x compatibility** — older Gateway builds validate `req` frames with `closedObject` and reject unknown top-level keys (`invalid request frame: at root: unexpected property 'traceparent'`).  The `GatewayRpcConnection` now negotiates `maxProtocol: 5` during `connect`, captures the negotiated `protocol` from the response, and only stamps the top-level `traceparent` field on `req` frames when `negotiated >= minTraceparentProtocol` (default 5).  Per-connection isolation means legacy and modern Gateways can coexist in the same pool without surprise rejections.  See `docs/traceparent.md` "Gateway protocol compatibility" and `tests/traceparent-protocol-gating.test.ts`.

### Added

- **End-to-end W3C `traceparent` propagation** — every outbound IPC `req` frame on `ws://127.0.0.1:18789` now carries a top-level `traceparent` field (`00-<traceId>-<spanId>-<flags>`, ≤ 128 chars), outbound A2A peer calls (REST/JSON-RPC/gRPC) carry the same value as a header / metadata entry, **and** inbound `traceparent` HTTP headers / gRPC metadata entries are lifted into an `AsyncLocalStorage` store so they propagate all the way through the executor's dispatch without requiring callers to put `traceparent` in A2A `metadata`. See `docs/traceparent.md` for the full contract.
- New `src/internal/traceparent.ts` utility (W3C Level-1 formatter / parser / child / validator) plus the process-global `AsyncLocalStorage` upstream-trace store. Drop-in compatible with `src/infra/diagnostic-trace-context.ts` from OpenClaw core via the `setTraceparentHooks({ getUpstreamTrace })` and `setTraceparentHooks({ randomBytes })` hooks.
- New `src/internal/grpc-traceparent.ts` server-side interceptor (`wrapGrpcServiceWithTraceparent`) that lifts the inbound `traceparent` metadata entry into the ALS scope for every method on the A2A `A2AServiceServer`.
- New `index.ts` express middleware (`traceparentMiddleware`) that lifts the inbound `traceparent` HTTP header into the ALS scope for both JSON-RPC and REST routes.
- `a2a.send` gateway method and `a2a_send_file` tool now resolve their upstream trace from the ALS store, so peer→plugin→peer calls stay on the same trace.
- New `observability.traceparent.{enabled, propagateOnConnect, minProtocolRequired, maxProtocol}` config switches; `minProtocolRequired` defaults to 5 (the version that introduces `traceparent` in the schema) so older Gateway builds get the silent-fallback path automatically.
- W3C ↔ gateway-internal envelope helpers (`w3cToEnvelopeTraceParts`, `envelopeToW3CTraceparent`, `generateEnvelopeTracePair`) in `src/internal/envelope.ts`.
- `npm run verify:traceparent` — single-command end-to-end verification harness with `--legacy-gateway` flag to test the silent-fallback path.  See `docs/traceparent-verification.md`.
- 64 new tests in `tests/traceparent*.test.ts` (utility, integration, inbound HTTP+gRPC→ALS, and protocol-version gating).

## [1.5.1] - 2026-07-04

### Fixed

- **Republished with freshly built `dist/`** — the 1.5.0 npm tarball shipped stale compiled output under `dist/src/` (still gateway protocol v3), so installs on OpenClaw 2026.6.x failed the ws handshake with `ws protocol mismatch: min=3 max=3 expected=4` even though the source already declared protocol v4 (#79)

### Added

- `build` script and `prepack` hook — `dist/` is now rebuilt automatically before every `npm pack` / `npm publish`, so published artifacts can no longer go stale relative to `src/`

## [1.5.0] - 2026-07-04

### Added

- **A2A DevTools CLI** (`cli/`, `@openclaw/a2a-cli`) — unified `a2a` command with 8 subcommands for gateway development and debugging: `card`, `send`, `status`, `health`, `discover`, `stream`, `bench`, `trace`
- **WebSocket connection pool** — reuses gateway RPC connections for dispatch, cutting scheduling latency by 50%+ (#32, #60)
- **Reverse proxy support** — run the gateway behind nginx/Caddy with path prefixes; proxy-aware URL handling plus deployment docs (#67)
- A2A routing recipes for TweetClaw (#76) and GetXAPI (#78)

### Changed

- npm package is now the recommended quick-start install (`npm i openclaw-a2a-gateway`); `data/` and docs are excluded from the tarball

### Fixed

- **OpenClaw 2026.5.x compatibility** — restored gateway method registration and startup activation against the new plugin runtime
- **OpenClaw gateway protocol v4 support** (#74)
- Blocking A2A agent event responses no longer stall the event loop (#77)
- Detect silent scope downgrade on cross-machine A2A connect (#54)
- `defaultAgentId` now matches the OpenClaw default (`"main"`, not `"default"`) (#57, #59)
- Raised A2A JSON body limit to allow inline file transfers (#69)
- Removed deprecated `grpcServer.start()` call (#80)

## [1.4.0] - 2026-04-04

### Added

- **Stale task recovery on startup** — gateway now scans `FileTaskStore` at startup and marks any tasks stuck in non-terminal states (submitted, working, input-required, auth-required, unknown) as `failed` with a clear reason message. Uses terminal-state allowlist for future-proofing. Includes re-entrancy guard matching `task-cleanup.ts` pattern. (#52)
- **CLI developer experience improvements** (#51):
  - Peer alias config (`~/.openclaw/a2a-peers.json`) — define named peers with URL + token, shared across all CLI scripts
  - `a2a-ping.mjs` — health check tool with `--peer`/`--all` modes, reports online/offline status with latency
  - `a2a-status.mjs` — query task status by ID, supports `--wait` polling with state transition display
  - Connection retry with exponential backoff (3x, 2/4/8s) for transient network errors
  - Actionable error diagnostics for ECONNREFUSED, ETIMEDOUT, ENOTFOUND, and 401 errors
  - Blocked state detection in polling loops (input-required/auth-required exit immediately)
- **Connection pooling** — reusable HTTP/gRPC connections for outbound A2A calls, reducing handshake overhead for high-frequency peer communication. (zycaskevin, #41)

### Fixed

- `a2a-send.mjs` `--peer` alias was unreachable due to early `!peerUrl` guard in `parseArgs()` — fixed to also check `opts.peer`
- `a2a-send.mjs` `terminalStates` was missing `rejected`, causing polling to spin until timeout on rejected tasks
- `a2a-peers.mjs` silently swallowed JSON parse errors — now reports syntax errors with clear diagnostic

## [1.3.0] - 2026-04-01

### Added

- **Bio-inspired integration wiring** — connect 5 standalone bio-inspired modules into the plugin runtime, making them activatable via config (Phase 2.5):
  - Hill equation affinity routing: `routing.affinity` config enables scored multi-dimensional matching instead of first-match
  - Quorum-sensing discovery: `discovery.quorum` config wraps DNS-SD polling with density-aware adaptive intervals
  - Signal decay retry: push notifications now use `sendWithRetry()` with exponential importance decay
  - Adaptive transport: per-peer `TransportStats` tracking with automatic performance-based ordering
  - Michaelis-Menten soft concurrency: `limits.saturation` config adds progressive delay before hard queue limit
- New config schema sections: `routing.affinity`, `discovery.quorum`, `limits.saturation` (all optional, backward-compatible)
- 5-dimension benchmark test suite (`tests/benchmark.test.ts`) comparing legacy vs bio-inspired behavior
- README repositioned with "When to enable" practical guidance for each bio-inspired feature

### Changed

- Push notification delivery upgraded from fire-and-forget `send()` to decay-aware `sendWithRetry()` with default DecayConfig
- Transport fallback loop now records per-peer performance stats for adaptive ordering on subsequent calls
- QueueingAgentExecutor applies Michaelis-Menten delay before task execution when saturation config is present

### Fixed

- `sendWithRetry()` was called without DecayConfig parameter, making signal decay retry effectively dead code — now passes default config (k=0.001, minImportance=0.1, maxRetries=3)
- TransportStats lookup hoisted out of fallback loop to avoid redundant Map.get per iteration

## [1.2.0] - 2026-03-24

### Added

- Peer skills caching — health check probes extract skills from Agent Card and cache them in `PeerHealthManager`, enabling skills-based routing rule matching (cf3d038)
- mDNS self-advertisement — publish PTR/SRV/TXT records on the local network so other A2A gateways can discover this instance automatically via DNS-SD; responds to queries, re-announces before TTL expiry, sends goodbye packet on shutdown (df98451)
- New config section `advertise` with `enabled`, `serviceName`, and `ttl` options (disabled by default)

## [1.1.0] - 2026-03-23

### Added

- URL-to-FilePart extraction — automatically detects file URLs in agent text responses and converts them to outbound A2A FileParts (PR #35)
- Cross-implementation compatibility test matrix with 20 test cases covering Agent Card, task lifecycle, streaming, and file transfer across SDK versions (PR #36)
- Automatic transport fallback — tries JSON-RPC → REST → gRPC in priority order with error classification and per-peer transport caching (PR #37)
- **P8**: Push notifications for long-running tasks — webhook registration, event delivery with retry, HMAC signature verification, SSRF-safe URL validation (PR #38)
- Rule-based routing engine — route outbound messages by pattern match, tag match, round-robin, and weighted random strategies with priority ordering (PR #39)
- DNS-SD dynamic agent discovery — resolve `_a2a._tcp` SRV/TXT records, auto-register discovered peers, periodic refresh with TTL-based eviction (PR #40)

### Security

- Push notification webhook endpoints protected with bearer auth middleware (PR #38)
- Webhook URL registration validates against SSRF via existing `validateUri` (PR #38)
- Routing rule regex patterns capped at 500 chars, message input truncated at 10K to mitigate ReDoS (PR #39)
- DNS discovery evicts expired peers on refresh failure to prevent stale routing (PR #40)

### Fixed

- SDK `pushNotifications: true` in Agent Card triggered built-in flow conflicts — set to `false` with custom implementation (PR #38)
- `stop()` in DNS discovery now clears `discoveredPeers` map to prevent memory leaks (PR #40)

## [1.0.1] - 2026-03-17

### Added

- Ed25519 device identity for OpenClaw ≥2026.3.13 scope compatibility, with auto-fallback for older versions (84f440c)
- Metrics endpoint optional bearer auth via `observability.metricsAuth: "bearer"` (#28)
- CI workflow running TypeScript check + tests on Node 22 and 25

### Fixed

- `auditLogPath` default changed to `~/.openclaw/a2a-audit.jsonl` for cross-platform consistency
- CI switched from `npm ci` to `npm install` to avoid lockfile mismatch failures

## [1.0.0] - 2026-03-15

### Added

- **P0**: Durable on-disk task persistence, concurrency limits (maxConcurrentTasks / maxQueuedTasks), structured JSON logs + telemetry metrics endpoint (PR #14)
- **P1**: Multi-round conversation support with contextId and message history (PR #15)
- **P2**: File transfer — full FilePart (URI + base64) and DataPart support, SSRF protections, MIME allowlist, URI hostname allowlist (PR #12, #13, #16)
- **P3**: Task TTL cleanup with configurable expiration interval (PR #19)
- **P4**: SSE streaming with heartbeat keep-alive for real-time task status updates (PR #21)
- **P5**: Peer resilience — health checks, retry with exponential backoff, circuit breaker pattern (PR #22)
- **P6**: Multi-token support for zero-downtime credential rotation (PR #23)
- **P7**: JSONL audit trail logging for all A2A calls and security events (PR #24)
- **P9**: Cross-platform default `tasksDir` path (`~/.openclaw/a2a-tasks`)
- `a2a_send_file` agent tool for programmatic file transfer to peers
- Agent skill at `skill/` for guided A2A setup (installation, peering, TOOLS.md)
- SDK-based CLI message sender (`skill/scripts/a2a-send.mjs`) using `@a2a-js/sdk` ClientFactory
- Async task mode with non-blocking send + polling for long-running prompts
- Per-message routing to specific peer OpenClaw agentId (OpenClaw extension)
- gRPC transport support (server + client)

### Fixed

- Missing `operator.read` / `operator.write` scopes in agent dispatch (PR #2)
- Deterministic session key from A2A contextId for reliable multi-agent routing (PR #3)
- Failed task status now properly returned when agent dispatch fails (PR #6)
- Gateway `connect.challenge` handshake handling
- Config shape unified — `security.fileSecurity` flattened into `security`
- Task cleanup retry logic hardened (PR #20)
- `operator.read/write` scopes restored after accidental loss in P5/P6 refactor

### Changed

- Zero-config install — plugin ships with sensible defaults, no manual configuration required (PR #10)
- Outbound A2A calls refactored to use `@a2a-js/sdk` ClientFactory
- All curl examples replaced with SDK script in documentation
- Shared test helpers extracted to reduce duplication across test files

## [0.1.0] - 2026-02-20

### Added

- Initial A2A v0.3.0 protocol implementation
- Agent Card endpoint at `/.well-known/agent-card.json`
- JSON-RPC and REST transport endpoints
- Bearer token authentication for inbound requests
- Agent dispatch via OpenClaw Gateway API
- Task lifecycle management (create, get, cancel)
- English and Chinese README

[1.2.0]: https://github.com/win4r/openclaw-a2a-gateway/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/win4r/openclaw-a2a-gateway/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/win4r/openclaw-a2a-gateway/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/win4r/openclaw-a2a-gateway/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/win4r/openclaw-a2a-gateway/commits/v0.1.0
