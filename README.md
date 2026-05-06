# 🦞 OpenClaw A2A Gateway Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-486%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

A production-ready [OpenClaw](https://github.com/openclaw/openclaw) plugin that implements the [A2A (Agent-to-Agent) v0.3.0 protocol](https://github.com/google/A2A), enabling OpenClaw agents to discover and communicate with each other across servers — with zero-config install and automatic peer discovery.

**The only A2A gateway with adaptive, bio-inspired routing, discovery, and resilience — designed for multi-agent ecosystems at scale.**

## Key Features

### Transport & Protocol
- **Three transports**: JSON-RPC, REST, and gRPC — with automatic fallback (tries JSON-RPC → REST → gRPC)
- **SSE streaming** with heartbeat keep-alive for real-time task status
- **Full Part type support**: TextPart, FilePart (URI + base64), DataPart (structured JSON)
- **Auto URL extraction**: file URLs in agent text responses are promoted to outbound FileParts

### Intelligent Routing
- **Rule-based routing**: auto-select peer by message pattern, tags, or peer skills
- **Hill equation affinity scoring**: multi-dimensional routing with sigmoid scoring — skills, tags, pattern, and success rate weighted via `score = affinity^n / (Kd^n + affinity^n)` ([Hill, 1910](https://en.wikipedia.org/wiki/Hill_equation_(biochemistry)))
- **Peer skills caching**: Agent Card skills extracted during health checks, enabling skills-based routing
- **Per-message agentId targeting**: route to specific OpenClaw agents on the peer (OpenClaw extension)

### Discovery & Resilience
- **DNS-SD discovery**: auto-discover peers via `_a2a._tcp` SRV + TXT records
- **mDNS self-advertisement**: publish SRV + TXT records so other gateways find you automatically
- **Quorum-sensing discovery**: density-aware adaptive polling — short intervals when few peers are known (explore), long intervals when the network is established (stable), with Schmitt-trigger hysteresis to prevent oscillation
- **Four-state circuit breaker**: bio-inspired desensitization model (closed → desensitized → open → recovering) with exponential recovery curve
- **Adaptive transport selection**: per-transport success rate and latency tracking with composite scoring — transports ranked by recent performance, with static priority tie-breaking
- **Push notifications**: webhook delivery with signal-decay importance management and decay-aware retry
- **Michaelis-Menten soft concurrency**: progressive delay before the hard queue limit — `delay = baseDelay × load / (Km + load)` provides a soft pressure zone instead of sudden rejection

### Security & Observability
- **Bearer token auth** with multi-token zero-downtime rotation
- **SSRF protection**: URI hostname allowlist, MIME allowlist, file size limits
- **Ed25519 device identity** for OpenClaw ≥2026.3.13 scope compatibility
- **JSONL audit trail** for all A2A calls and security events
- **Telemetry metrics** endpoint with optional bearer auth
- **Durable task store** on disk with TTL cleanup and concurrency limits

## Architecture

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Prerequisites

- **OpenClaw** ≥ 2026.3.0 installed and running
- **Network connectivity** between servers (Tailscale, LAN, or public IP)
- **Node.js** ≥ 22

## Installation

### Quick Start (zero-config)

The plugin ships with sensible defaults — you can install and load it **without any manual configuration**:

```bash
# Install from npm (recommended)
openclaw plugins install openclaw-a2a-gateway
```

Or install from source:

```bash
# Clone
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Register & enable
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Restart
openclaw gateway restart

# Verify
openclaw plugins list          # should show a2a-gateway as loaded
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

The plugin will start with the default Agent Card (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). You can customize it later — see [Configure the Agent Card](#3-configure-the-agent-card) below.

### Step-by-Step Installation

If you prefer manual control or need to keep existing plugins in your config:

### 1. Clone the plugin

```bash
# Into your workspace plugins directory
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Register the plugin in OpenClaw

```bash
# Add to allowed plugins list
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Tell OpenClaw where to find the plugin
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Enable the plugin
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Note:** Replace `<FULL_PATH_TO>` with the actual absolute path, e.g., `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Keep any existing plugins in the `plugins.allow` array.

### 3. Configure the Agent Card

Every A2A agent needs an Agent Card that describes itself. If you skip this step, the plugin uses these defaults:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

To customize:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Important:** Replace `<YOUR_IP>` with the IP address reachable by your peers (Tailscale IP, LAN IP, or public IP).

### 4. Configure the A2A server

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Configure security (recommended)

Generate a token for inbound authentication:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Save this token — peers will need it to authenticate with your agent.

### 6. Configure agent routing

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Restart the gateway

```bash
openclaw gateway restart
```

### 8. Verify

```bash
# Check the Agent Card is accessible
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

You should see your Agent Card with name, skills, and URL.

## Adding Peers

To communicate with another A2A agent, add it as a peer:

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "PeerName",
    "agentCardUrl": "http://<PEER_IP>:18800/.well-known/agent-card.json",
    "auth": {
      "type": "bearer",
      "token": "<PEER_TOKEN>"
    }
  }
]'
```

Then restart:

```bash
openclaw gateway restart
```

### Mutual Peering (Both Directions)

For two-way communication, **both servers** need to add each other as peers:

| Server A | Server B |
|----------|----------|
| Peer: Server-B (with B's token) | Peer: Server-A (with A's token) |

Each server generates its own security token and shares it with the other.

## Sending Messages via A2A

### From the command line

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

The script uses `@a2a-js/sdk` ClientFactory to auto-discover the Agent Card and select the best transport.

### Async task mode (recommended for long-running prompts)

For long prompts or multi-round discussions, avoid blocking a single request. Use non-blocking mode + polling:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --non-blocking \
  --wait \
  --timeout-ms 600000 \
  --poll-ms 1000 \
  --message "Discuss A2A advantages in 3 rounds and provide final conclusion"
```

This sends `configuration.blocking=false` and then polls `tasks/get` until the task reaches a terminal state.

Tip: the default `--timeout-ms` for the script is 10 minutes; override it for very long tasks.

### Target a specific OpenClaw agentId (OpenClaw extension)

By default, the peer routes inbound A2A messages to `routing.defaultAgentId` (often `main`).

To route a single request to a specific OpenClaw `agentId` on the peer, pass `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

This is implemented as a non-standard `message.agentId` field understood by this plugin. It is most reliable over JSON-RPC/REST. gRPC transport may drop unknown Message fields.

### Agent-side runtime awareness (TOOLS.md)

Even if the plugin is installed and configured, an LLM agent will not reliably "infer" how to call A2A peers (peer URL, token, command to run). For dependable **outbound** A2A calls, you should add an A2A section to the agent's `TOOLS.md`.

Add this to your agent's `TOOLS.md` so it knows how to call peers (see `skill/references/tools-md-template.md` for the full template):

```markdown
## A2A Gateway (Agent-to-Agent Communication)

You have an A2A Gateway plugin running on port 18800.

### Peers

| Peer | IP | Auth Token |
|------|-----|------------|
| PeerName | <PEER_IP> | <PEER_TOKEN> |

### How to send a message to a peer

Use the exec tool to run:

\```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "YOUR MESSAGE HERE"

# Optional (OpenClaw extension): route to a specific peer agentId
#  --agent-id coder
\```

The script auto-discovers the Agent Card, handles auth, and prints the peer's response text.
```

Then users can say things like:
- "Send to PeerName: what's your status?"
- "Ask PeerName to run a health check"

## A2A Part Types

The plugin supports all three A2A Part types for inbound messages. Since the OpenClaw Gateway RPC only accepts plain text, each Part type is serialized into a human-readable format before dispatching to the agent.

| Part Type | Format Sent to Agent | Example |
|-----------|---------------------|---------|
| `TextPart` | Raw text | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | URI-based file reference |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Inline file with size hint |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Structured JSON data (truncated at 2KB) |

For outbound responses, the plugin converts structured `mediaUrl`/`mediaUrls` fields from the agent payload into `FilePart` entries in the A2A response. Additionally, file URLs embedded in the agent's text response (markdown links like `[report](https://…/report.pdf)` and bare URLs like `https://…/data.csv`) are automatically extracted into `FilePart` entries when they end with a recognized file extension.

### a2a_send_file Agent Tool

The plugin registers an `a2a_send_file` tool that agents can call to send files to peers:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Yes | Target peer name (must match a configured peer) |
| `uri` | Yes | Public URL of the file to send |
| `name` | No | Filename (e.g., `report.pdf`) |
| `mimeType` | No | MIME type (auto-detected from extension if omitted) |
| `text` | No | Optional text message alongside the file |
| `agentId` | No | Route to a specific agentId on the peer (OpenClaw extension) |

Example agent interaction:
- User: "Send the test report to AWS-bot"
- Agent calls `a2a_send_file` with `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Network Setup

### Option A: Tailscale (Recommended)

[Tailscale](https://tailscale.com/) creates a secure mesh network between your servers with zero firewall configuration.

```bash
# Install on both servers
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate (same account on both)
sudo tailscale up

# Check connectivity
tailscale status
# You'll see IPs like 100.x.x.x for each machine

# Verify
ping <OTHER_SERVER_TAILSCALE_IP>
```

Use the `100.x.x.x` Tailscale IPs in your A2A configuration. Traffic is encrypted end-to-end.

### Option B: LAN

If both servers are on the same local network, use their LAN IPs directly. Make sure port 18800 is accessible.

### Option C: Public IP

Use public IPs with bearer token authentication. Consider adding firewall rules to restrict access to known IPs. If you use a reverse proxy, please refer to [NETWORK.md](./docs/NETWORK.md).

## Full Example: Two-Server Setup

### Server A setup

```bash
# Generate Server A's token
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# Configure A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Add Server B as peer (use B's token)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Server B setup

```bash
# Generate Server B's token
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# Configure A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Add Server A as peer (use A's token)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Verify both directions

```bash
# From Server A → test Server B's Agent Card
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# From Server B → test Server A's Agent Card
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Send a message A → B (using SDK script)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Configuration Reference

### Core

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Display name for this agent |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Human-readable description |
| `agentCard.url` | string | auto | JSON-RPC endpoint URL |
| `agentCard.grpcProxy` | boolean | `false` | When `true`, publish the gRPC URL from the same base URL as JSON-RPC/REST to support reverse proxy, without changing the local listener |
| `agentCard.skills` | array | `[{chat}]` | List of skills this agent offers |
| `server.host` | string | `0.0.0.0` | Bind address |
| `server.port` | number | `18800` | A2A HTTP port (gRPC still listens on port+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Durable on-disk task store path |
| `storage.taskTtlHours` | number | `72` | Auto-cleanup expired tasks after N hours |
| `storage.cleanupIntervalMinutes` | number | `60` | How often to scan for expired tasks |

### Peers

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | List of peer agents |
| `peers[].name` | string | *required* | Peer display name |
| `peers[].agentCardUrl` | string | *required* | URL to peer's Agent Card |
| `peers[].auth.type` | string | — | `bearer` or `apiKey` |
| `peers[].auth.token` | string | — | Authentication token |

### Security

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` or `bearer` |
| `security.token` | string | — | Single token for inbound auth |
| `security.tokens` | array | `[]` | Multiple tokens for zero-downtime rotation |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Allowed MIME patterns for file transfer |
| `security.maxFileSizeBytes` | number | `52428800` | Max file size for URI-based files (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Max inline base64 file size (10MB) |
| `security.fileUriAllowlist` | array | `[]` | URI hostname allowlist (empty = allow all public) |

### Routing

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | Agent ID for inbound messages |
| `routing.rules` | array | `[]` | Rule-based routing rules (see below) |
| `routing.rules[].name` | string | *required* | Rule name |
| `routing.rules[].match.pattern` | string | — | Regex to match message text (case-insensitive) |
| `routing.rules[].match.tags` | array | — | Match if message has any of these tags |
| `routing.rules[].match.skills` | array | — | Match if target peer has any of these skills |
| `routing.rules[].target.peer` | string | *required* | Peer to route to |
| `routing.rules[].target.agentId` | string | — | Override agentId on the peer |
| `routing.rules[].priority` | number | `0` | Higher = checked first |

### Resilience

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Enable periodic Agent Card probes |
| `resilience.healthCheck.intervalMs` | number | `30000` | Probe interval (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Probe timeout (ms) |
| `resilience.retry.maxRetries` | number | `3` | Max retries for failed outbound calls |
| `resilience.retry.baseDelayMs` | number | `1000` | Base delay for exponential backoff |
| `resilience.retry.maxDelayMs` | number | `10000` | Max delay cap |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Failures before circuit opens |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Cooldown before half-open probe |

### Discovery & Advertisement

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Enable DNS-SD peer discovery |
| `discovery.serviceName` | string | `_a2a._tcp.local` | DNS-SD service name to query |
| `discovery.refreshIntervalMs` | number | `30000` | How often to re-query DNS (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Merge discovered peers with static config |
| `advertise.enabled` | boolean | `false` | Enable mDNS self-advertisement |
| `advertise.serviceName` | string | `_a2a._tcp.local` | DNS-SD service type to advertise |
| `advertise.ttl` | number | `120` | TTL in seconds for advertised records |

### Observability

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Emit JSON structured logs |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Expose telemetry snapshot over HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | HTTP path for telemetry |
| `observability.metricsAuth` | string | `none` | `none` or `bearer` for metrics endpoint |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Path for JSONL audit log |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Max wait for agent response (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Max active inbound agent runs |
| `limits.maxQueuedTasks` | number | `100` | Max queued tasks before rejection |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card discovery *(alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC transport |
| `/a2a/rest` | POST | A2A REST transport |
| `<host>:<port+1>` | gRPC | A2A gRPC transport *(or `${origin}` in the Agent Card when `agentCard.grpcUrl=true`)* |
| `/a2a/metrics` | GET | Telemetry snapshot (optional bearer auth) |
| `/a2a/push/register` | POST | Register push notification webhook |
| `/a2a/push/:taskId` | DELETE | Unregister push notification |

## DevTools CLI

A companion CLI for developing and debugging A2A connections. Included in the `cli/` directory.

```bash
cd cli && npm install && npm link   # or: npx tsx cli/bin/a2a.ts
```

| Command | Purpose |
|---------|---------|
| `a2a health <peer>` | Check if a peer is online (fetches Agent Card) |
| `a2a health --all` | Ping all configured peers at once |
| `a2a card <url>` | Display a remote Agent Card |
| `a2a send <peer> "message"` | Send a message and show the response |
| `a2a stream <peer> "message"` | Stream a response via SSE in real-time |
| `a2a status <peer> <taskId>` | Query task status (with `--wait` for polling) |
| `a2a discover` | Scan the local network for A2A agents via mDNS |
| `a2a trace <peer> "message"` | Request lifecycle waterfall (resolve → card → send) |
| `a2a bench <peer>` | Load test with latency percentiles (P50/P90/P99) |

All commands support `--json` for pipe-friendly output. Peers can be aliases from `~/.openclaw/a2a-peers.json` or direct URLs.

## Troubleshooting

### "Request accepted (no agent dispatch available)"

This means the A2A request was accepted by the gateway, but the underlying OpenClaw agent dispatch did not complete.

Common causes:

1) **No AI provider configured** on the target OpenClaw instance.

```bash
openclaw config get auth.profiles
```

2) **Agent dispatch timed out** (long-running prompt / multi-round discussion).

Fix options:
- Use async task mode from the sender: `--non-blocking --wait`
- Increase the plugin timeout: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (default: 300000)


### Agent Card returns 404

The plugin isn't loaded. Check:

```bash
# Verify plugin is in allow list
openclaw config get plugins.allow

# Verify load path is correct
openclaw config get plugins.load.paths

# Check gateway logs
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Connection refused on port 18800

```bash
# Check if the A2A server is listening
ss -tlnp | grep 18800

# If not, restart gateway
openclaw gateway restart
```

### Peer authentication fails

Make sure the token in your peer config matches the `security.token` on the target server exactly.

## Agent Skill (for OpenClaw / Codex CLI)

This repo includes a ready-to-use **skill** at `skill/` that guides AI agents (OpenClaw, Codex CLI, Claude Code, etc.) through the full A2A setup process step by step — including installation, configuration, peer registration, TOOLS.md setup, and verification.

### Why use the skill?

Manually configuring A2A involves many steps with specific field names, URL patterns, and token handling. The skill encodes all of this as a repeatable procedure, preventing common mistakes like:

- Confusing `agentCard.url` (JSON-RPC endpoint) with `peers[].agentCardUrl` (Agent Card discovery)
- Forgetting to update TOOLS.md (agent won't know how to call peers)
- Using relative paths in `plugins.load.paths` (must be absolute)
- Missing mutual peer registration (both sides need each other's config)

### Install the skill

**For OpenClaw:**

```bash
# Copy to your skills directory
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Or symlink
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**For Codex CLI:**

```bash
# Copy to Codex skills directory
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**For Claude Code:**

```bash
# Copy to your project or workspace
cp -r <repo>/skill ./skills/a2a-setup
```

### What's in the skill

```
skill/
├── SKILL.md                          # Step-by-step setup guide
├── scripts/
│   └── a2a-send.mjs                  # SDK-based message sender (official @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # TOOLS.md template for agent A2A awareness
```

The skill provides two methods for agents to call peers:
- **curl** — universal, works everywhere
- **SDK script** — uses `@a2a-js/sdk` ClientFactory with auto agent card discovery and transport selection

### Usage

Once installed, tell your agent:

- "Set up A2A gateway" / "配置 A2A"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

The agent will follow the skill's procedure automatically.

## Bio-inspired Design

As multi-agent ecosystems scale from 2 peers to 20 or 200, standard A2A gateways hit predictable walls: routing picks the wrong peer, circuit breakers cut traffic entirely, discovery polls waste bandwidth, and overload hits like a cliff. This gateway solves these with mechanisms borrowed from **cell signaling biology** — the same principles cells use to route signals, handle receptor overload, and discover neighbors in dense tissue.

| Biology | Mechanism | A2A Feature | Reference |
|---------|-----------|-------------|-----------|
| Ligand-receptor binding | Hill equation sigmoid | **Affinity-scored routing** — multi-dimensional match scoring with configurable steepness (n) and threshold (Kd) | Hill (1910) *J Physiol* 40 |
| Receptor desensitization | Phosphorylation → internalization → recycling | **Four-state circuit breaker** — gradual degradation (DESENSITIZED) before full block (OPEN), with exponential recovery curve | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP degradation | Phosphodiesterase enzyme decay | **Signal decay notifications** — importance score decays exponentially; retry abandoned when below threshold | Alon (2007) *Intro to Systems Biology* Ch.4 |
| Quorum sensing | Autoinducer concentration threshold | **Density-aware discovery** — adaptive polling with hysteresis (explore ↔ stable mode) based on peer population | Tamsir *et al.* (2011) *Nature* 469:212 |
| Signal pathway selection | Pathway efficacy × transduction speed | **Adaptive transport** — per-transport scoring by success rate × latency factor; untested pathways get explore-first priority | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Enzyme saturation | Michaelis-Menten kinetics | **Soft concurrency limiting** — progressive delay `baseDelay × load/(Km + load)` before the hard queue wall | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### When to enable

All bio-inspired features are **optional and backward-compatible** — without explicit configuration, the gateway behaves identically to standard implementations. Enable them when your deployment outgrows the defaults:

| Feature | Enable when... | Config key |
|---------|---------------|------------|
| Hill affinity routing | 5+ peers with overlapping skills | `routing.affinity` |
| Four-state circuit breaker | Peers have intermittent failures | `resilience.circuitBreaker.softThreshold` |
| Signal decay retry | Webhook endpoints are unreliable | Enabled by default |
| Quorum-sensing discovery | Dynamic peer networks with DNS-SD | `discovery.quorum` |
| Adaptive transport | Peers expose multiple transports | Automatic (learns from usage) |
| MM soft concurrency | High-throughput sub-second operations | `limits.saturation` |

> Benchmark suite: `node --import tsx --test tests/benchmark.test.ts` — runs 5-dimension before/after comparison across all bio-inspired features.

## Version History

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | Peer skills routing, mDNS self-advertisement (symmetric discovery) |
| **v1.1.0** | URL extraction, transport fallback, push notifications, rule-based routing, DNS-SD discovery |
| **v1.0.1** | Ed25519 device identity, metrics auth, CI |
| **v1.0.0** | Production-ready: persistence, multi-round, file transfer, SSE, health checks, multi-token, audit |
| **v0.1.0** | Initial A2A v0.3.0 implementation |

See [CHANGELOG.md](CHANGELOG.md) for full details and [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) for downloads.

## License

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
