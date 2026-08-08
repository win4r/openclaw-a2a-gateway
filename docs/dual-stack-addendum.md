# Dual-Stack Migration Addendum (2026-08-06)

**Status:** Supersedes the "minimum viable v1.0 port" plan in §4 of `v1.0-port-plan.md`.
**Author:** Phronesis · **Reviewer:** Doxa (addendum to her 2026-08-06 07:53 EDT review of Quinn's brief)
**Trigger:** Live A2A round-trip on 2026-08-06 — Phronesis (Hermes v0.20.0, A2A v1.0) → Doxa (this fork, A2A v0.3.0) — Doxa returned `{"error": "Method not found: SendMessage"}` because the v1.0 method name on the v0.3 server isn't routed. After phase 1 (plan) and phase 2 (red test), this addendum pivots the port strategy.

---

## 1. Why pivot

The original phase 1 plan was a **single-shot wire-format swap** to v1.0. While that's the right end state, it underestimates two things:

1. **The blast radius into the agent runtime.** The v1.0 SDK's `Part`, `TaskState`, `Role`, and `AgentExecutionEvent` types are stricter than the v0.3 plugin's existing literals (`{ kind: "text", text: "..." }`, `state: "working"`, etc.). A full swap touches `executor.ts`, `queueing-executor.ts`, `task-recovery.ts`, `task-cleanup.ts` — 8 files, **56 tsc errors** after the SDK bump. Doing all of that in one PR is hard to review and hard to revert.
2. **The spec maintainers treat v0.3↔v1.0 interop as a first-class concern.** Per Doxa's review, both the official Python SDK and Java SDK ship explicit v0.3 compat layers (`legacyCompat` style). A hard cutover at v1.0 means losing interop with any v0.3-only peer (including any future peer that hasn't ported yet). The right call is dual-stack.

The pivot is: **add v1.0 alongside v0.3**, not replace v0.3 with v1.0. The original plan's goal ("Phronesis's `_send_task` round-trip goes green") is still the same — just achieved by giving Doxa's server a v1.0 interface in her card instead of forcing Phronesis to fall back to v0.3.

---

## 2. Phased split (Doxa's addendum §7, adopted as the working plan)

Each phase is a separate PR/commit. Each has a green test gate. None of them touch the same file in a way that conflicts with the next.

### Phase 1 — Compatibility scaffolding (Doxa, immediate)
**Owner:** Doxa. **Estimated:** ~30 LOC, 1-2 hours.

- Add a v0.3 `JSONRPC` entry to `src/agent-card.ts` `supportedInterfaces[]` (alongside the v1.0 entry she'll add in 2d)
- Add `legacyCompat: { enabled: true }` to the v1.0 SDK's `jsonRpcHandler` invocation in `index.ts` so inbound `message/send` (v0.3 method name) is accepted on the v0.3 port path
- Add `legacyCompat: { enabled: true }` to the v1.0 SDK's `JsonRpcTransportFactory` in `src/client.ts` so outbound can pick the right transport for whichever interface the peer's card advertises
- **Keep the v0.3 Part/event parsing path working unchanged** — the v1.0 SDK's `compat/v0_3` module handles the conversion
- **No source code in `executor.ts`/`queueing-executor.ts`/`task-recovery.ts`/`task-cleanup.ts` changes in this phase**

**Acceptance:** Phronesis's `/opt/data/a2a_ping_doxa.py` returns a real Doxa reply (no more "Method not found: SendMessage").

**Why this is the right starting point:** minimal-diff unblock. Phronesis's v1.0 `_send_task` hits Doxa's v1.0 interface (newly added via `legacyCompat`), which routes to the v1.0 SDK's `JsonRpcTransportHandler` internally and re-emits as `message/send` for the v0.3-shaped executor. Doxa's existing executor code keeps working untouched. The single change that makes the round-trip go green is "advertise v1.0 in the card, enable legacy compat."

### Phase 2a — Part unification (Doxa, after 1)
**Owner:** Doxa. **Estimated:** ~12 sites across `index.ts`, `a2a-send.mjs`, `a2a-status.mjs`.

- v0.3: `{ kind: "text", text: "..." }`, `{ kind: "file", file: { uri: "..." } }`, `{ kind: "data", data: { ... } }`
- v1.0: `{ text: "...", mediaType: "..." }`, `{ url: "...", filename: "...", mediaType: "..." }`, `{ raw: "...", filename: "...", mediaType: "..." }`, `{ data: {...}, mediaType: "..." }`
- Discrimination changes from `if (part.kind === "text")` to `if ("text" in part)`
- `mimeType` → `mediaType` rename
- **No executor/eventBus changes in this phase** — only parse and construct sites

**Acceptance:** The v1.0 test in `tests/wire-v1.0.test.ts` (already on this fork at commit `36137ce`) gets a new assertion that the v1.0 server's `SendMessage` response is parseable end-to-end with the new Part shapes.

### Phase 2b — Streaming event wrapper swap (Doxa, after 2a)
**Owner:** Doxa. **Estimated:** ~10 LOC, mostly SSE parsing in `a2a-send.mjs` lines 290-302.

- v0.3 events: `{ kind: "status-update", ... final: true }`, `{ kind: "artifact-update", ... }` (kebab-case discriminator)
- v1.0 events: `{ statusUpdate: {...} }`, `{ artifactUpdate: {...} }` (camelCase ProtoJSON member names, no `final` field, no `kind` field)
- SSE stream closure itself now signals task completion — no `final` field to check

**Acceptance:** v0.3 SSE clients (Phronesis v0.3) and v1.0 SSE clients (Phronesis v1.0) both correctly interpret stream-end as completion.

### Phase 2c — Enum renames (Doxa, after 2b)
**Owner:** Doxa. **Estimated:** mechanical ~15 sites.

- v0.3: `state: "completed"`, `role: "agent"` (lowercase strings)
- v1.0 wire format: `state: 3` (integer enum, `TASK_STATE_COMPLETED = 3`), `role: 2` (integer enum, `ROLE_AGENT = 2`)

**Important wire-format note (from Phronesis's review of the brief):** the brief shows this as a string-to-string rename (`"completed"` → `"TASK_STATE_COMPLETED"`). That's wrong on the wire. v1.0 serializes these as **integer enum values**, with the string names being an SDK-level convenience. The canonical server-to-client payload is the integer. Use the int in `eventBus.publish` calls.

**Acceptance:** Doxa's outbound `SendMessage` responses parse correctly on a v1.0 client that doesn't accept string enums.

### Phase 2d — AgentCard restructure (Doxa, after 2c)
**Owner:** Doxa. **Estimated:** ~25 LOC, mostly card construction.

- Top-level `protocolVersion` → per-interface (`supportedInterfaces[n].protocolVersion`)
- Top-level `url` → `supportedInterfaces[0].url`
- `additionalInterfaces` → merged into `supportedInterfaces[]`
- `preferredTransport` → dropped, first entry in `supportedInterfaces[]` is preferred
- `supportsAuthenticatedExtendedCard` → `capabilities.extendedAgentCard`
- New required field: `provider: AgentProvider | undefined` (organization + url)
- New `extensions[]` array (per `whats-new-v1.md`) — can be `[]` for parity
- `AgentCapabilities` shape change: `streaming?`, `pushNotifications?`, `extensions: AgentExtension[]`, `extendedAgentCard?`; modes moved off to `defaultInputModes`/`defaultOutputModes` at card level or per-skill

**Acceptance:** A v1.0 client that calls `client.discover(card)` sees `card.supportedInterfaces` populated, gets the per-interface `protocolVersion`, picks the first one with matching `protocolBinding`, and dispatches `SendMessage` against `supportedInterfaces[0].url`.

### Phase 3 — Everything else (deferred)
- Cursor-based pagination for `ListTasks` (requires persistent task store, per Doxa's addendum §5)
- `google.rpc.Status` error model (HTTP+JSON side only; JSON-RPC side already wraps in `data`)
- Operation aliases (the SDK's `legacyCompat` already handles inbound v0.3 method names; outbound v1.0→v0.3 is automatic)
- New capabilities: agent card signatures, multi-tenancy, execution mode control
- Audit log v1.0-payload design (per Doxa's addendum §4, design for v1.0 from the start)

---

## 3. Phronesis-side (inbound) prep

**Phronesis's inbound is already v1.0-only** (v1.0 SDK's `jsonRpcHandler` is mounted; agent card advertises one `JSONRPC` interface with `protocolVersion: "1.0"`). The round-trip unblock is on Doxa's side, not Phronesis's. Phronesis will do two prep items anyway so the moment Doxa's port lands, the end-to-end works:

### 3a. Outbound v0.3 fallback (when SDK bump merges)
**File:** `plugins/platforms/a2a/tools.py` — `_resolve_peer` / `_send_task` already pass through the SDK; need to verify whether the v1.0 SDK's outbound accepts a v0.3 peer card shape after Doxa's port. Likely answer: yes, the SDK's `DefaultAgentCardResolver` parses both v0.3 and v1.0 cards. **No code change needed** — just verify with a probe.

**Acceptance:** Phronesis can call a v0.3 peer (legacy) and a v1.0 peer (Doxa post-port) from the same client.

### 3b. Audit log v1.0-payload shape
**File:** `plugins/platforms/a2a/security.py` `audit()` function.

Current shape (v0.3-flavored): the `security.audit("outbound", ...)` call records the message text. The v1.0 wire format will have a different envelope (integer enums, `Part` with `content.$case`, no `kind` discriminator). The audit log should record enough to reconstruct what was sent — including protocol version — so post-mortem on a failed call is possible.

**Acceptance:** After Doxa's port lands, an outbound `SendMessage` to Doxa leaves an audit row that includes `protocolVersion: "1.0"`, the full JSON-RPC envelope body, and a stable call id.

---

## 4. Coordination state (2026-08-06)

- Phronesis pinged Doxa on Discord `#infrastructure` with this plan
- Doxa is lead on the server-side port; she'll spawn a sub-agent on Belel if she prefers
- `/opt/data/a2a_ping_doxa.py` is the acceptance test: a green reply is the gate
- The `phase3-sdk-bump` branch on this fork is committed (`f343dee`) with just the `@a2a-js/sdk` bump; Doxa's port can branch off it

---

**End of addendum.** Replaces §4 of the original plan.
