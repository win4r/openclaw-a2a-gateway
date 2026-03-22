# A2A Compatibility Matrix

This document tracks interoperability between the OpenClaw A2A Gateway and other A2A protocol implementations.

## Protocol Coverage

| Feature | OpenClaw A2A Gateway | Notes |
|---------|---------------------|-------|
| Protocol Version | 0.3.0 | Also accepts 0.3.1 Agent Cards |
| JSON-RPC transport | Supported | Primary transport |
| REST transport | Supported | Via `/a2a/rest` endpoint |
| gRPC transport | Supported | On port+1 |
| SSE streaming | Supported | Heartbeat keep-alive |
| Push notifications | Not supported | Planned |
| Agent Card discovery | Supported | `/.well-known/agent-card.json` |
| Bearer auth | Supported | Inbound and outbound |
| API Key auth | Supported | Outbound only |
| TextPart | Supported | Inbound and outbound |
| FilePart (URI) | Supported | Inbound and outbound |
| FilePart (base64) | Supported | Inbound only |
| DataPart | Supported | Inbound only |

## Implementation Compatibility

| Implementation | Version | Agent Card | Message Send | Streaming | File Transfer | Status |
|---|---|---|---|---|---|---|
| **OpenClaw A2A Gateway** (this project) | 1.0.1 | Tested | Tested | Tested | Tested | Fully tested |
| **Google A2A Reference** (Python) | — | Untested | Untested | Untested | Untested | Planned |
| **@a2a-js/sdk reference server** | 0.3.x | Untested | Untested | Untested | Untested | Planned |
| **LangChain A2A adapter** | — | Untested | Untested | Untested | Untested | Not planned |
| **CrewAI A2A adapter** | — | Untested | Untested | Untested | Untested | Not planned |

### Legend

- **Tested** — covered by automated tests in `tests/compat-matrix.test.ts`
- **Untested** — not yet tested; expected to work based on spec compliance
- **Planned** — live integration tests planned for a future release
- **Not planned** — no current plan; community contributions welcome

## Tested Scenarios

The `tests/compat-matrix.test.ts` file validates the following cross-implementation scenarios:

### Agent Card Variations

| Scenario | Status | Description |
|---|---|---|
| Minimal card | Tested | Only `protocolVersion`, `name`, `url`, `skills` |
| Extra unknown fields | Tested | Forward compatibility with future spec fields |
| Diverse skill formats | Tested | With/without `id`, `tags`, `description` |
| No optional fields | Tested | No `securitySchemes`, no `additionalInterfaces` |
| Protocol version 0.3.0 | Tested | Standard version |
| Protocol version 0.3.1 | Tested | Minor version bump |
| buildAgentCard defaults | Tested | Empty/partial/full config inputs |

### Inbound Message Formats

| Scenario | Status | Description |
|---|---|---|
| TextPart only | Tested | Standard single-part text message |
| Mixed parts (Text + File + Data) | Tested | Multi-part message with all types |
| Empty parts array | Tested | Graceful handling of no content |
| Extra unknown fields on parts | Tested | Forward compatibility |
| Missing `role` field | Tested | Defaults gracefully |

### Response Formats

| Scenario | Status | Description |
|---|---|---|
| Standard JSON-RPC result | Tested | `result.task` with completed status |
| JSON-RPC error (-32600) | Tested | Standard error code handling |
| Custom vendor error code | Tested | Non-standard error codes (e.g., -50000) |
| TextPart response | Tested | Single text part in response |
| Mixed text + mediaUrls | Tested | Text + FilePart generation from media URLs |

### Transport Headers

| Scenario | Status | Description |
|---|---|---|
| Bearer auth outbound | Tested | Correct `Bearer <token>` prefix |
| API Key auth outbound | Tested | Correct `x-api-key` header |
| Bearer auth inbound (valid) | Tested | Accepts correct token |
| Bearer auth inbound (missing) | Tested | Rejects missing token |
| Raw token without prefix | Tested | Rejects token without `Bearer ` prefix |

## Known Interoperability Notes

1. **gRPC transport**: The `message.agentId` extension field (OpenClaw-specific) may be dropped by implementations using strict protobuf Message definitions. Use JSON-RPC or REST transport when `agentId` routing is needed.

2. **Agent Card path**: This gateway serves the Agent Card at both `/.well-known/agent-card.json` (current spec) and `/.well-known/agent.json` (legacy). Some older implementations may only check the legacy path.

3. **Error codes**: The gateway uses standard JSON-RPC error codes (-32600, -32601, -32603, -32700). Some implementations use custom codes in the -50000 range; the client handles these gracefully.

4. **Inline FilePart (base64)**: Not all implementations support base64-encoded file content. When sending files to peers, URI-based FilePart is preferred for maximum compatibility.

## Contributing

To add test coverage for a new A2A implementation:

1. Add mock responses that simulate the implementation's payload format to `tests/compat-matrix.test.ts`
2. Update the compatibility table above
3. If possible, add a live integration test in a separate file (e.g., `tests/compat-live-google.test.ts`)
