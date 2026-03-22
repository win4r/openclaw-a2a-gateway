# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[1.0.1]: https://github.com/win4r/openclaw-a2a-gateway/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/win4r/openclaw-a2a-gateway/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/win4r/openclaw-a2a-gateway/commits/v0.1.0
