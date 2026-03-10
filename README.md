# 🦞OpenClaw A2A Gateway Plugin

**English** | [简体中文](README_CN.md)

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that implements the [A2A (Agent-to-Agent) v0.3.0 protocol](https://github.com/google/A2A), enabling OpenClaw agents to communicate with each other across different servers.

## What It Does

- Exposes an **A2A-compliant endpoint** (JSON-RPC + REST) so other agents can send messages to your OpenClaw agent
- Publishes an **Agent Card** at `/.well-known/agent-card.json` for peer discovery (legacy alias: `/.well-known/agent.json`)
- Supports **bearer token authentication** for secure inter-agent communication
- Routes inbound A2A messages to your OpenClaw agent and returns the response
- Allows your agent to **call peer agents** via the A2A protocol
- Handles **A2A Part types** end-to-end: `TextPart`, `FilePart` (URI + base64), and `DataPart` (structured JSON)
- Provides an **`a2a_send_file` agent tool** so your agent can send files to peers programmatically

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

For outbound responses, the plugin converts structured `mediaUrl`/`mediaUrls` fields from the agent payload into `FilePart` entries in the A2A response.

> **Note:** Outbound FilePart generation relies on structured `mediaUrl`/`mediaUrls` fields in the agent payload. URLs embedded in plain text (e.g., markdown links) are not automatically extracted into FileParts.

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

Use public IPs with bearer token authentication. Consider adding firewall rules to restrict access to known IPs.

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

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Display name for this agent |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Human-readable description |
| `agentCard.url` | string | auto | JSON-RPC endpoint URL |
| `agentCard.skills` | array | `[{chat}]` | List of skills this agent offers |
| `server.host` | string | `0.0.0.0` | Bind address |
| `server.port` | number | `18800` | A2A server port |
| `storage.tasksDir` | string | `data/tasks` | Durable on-disk task store path |
| `peers` | array | `[]` | List of peer agents |
| `peers[].name` | string | *required* | Peer display name |
| `peers[].agentCardUrl` | string | *required* | URL to peer's Agent Card |
| `peers[].auth.type` | string | — | `bearer` or `apiKey` |
| `peers[].auth.token` | string | — | Authentication token |
| `security.inboundAuth` | string | `none` | `none` or `bearer` |
| `security.token` | string | — | Token for inbound auth |
| `routing.defaultAgentId` | string | `default` | Agent ID for inbound messages |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Max wait time (ms) for agent response |
| `limits.maxConcurrentTasks` | number | `4` | Max active inbound agent runs |
| `limits.maxQueuedTasks` | number | `100` | Max queued inbound tasks before rejection |
| `observability.structuredLogs` | boolean | `true` | Emit JSON structured logs |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Expose telemetry snapshot over HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | HTTP path for telemetry snapshot |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card (discovery) *(legacy alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC (message/send) |
| `/a2a/rest` | POST | A2A REST transport |
| `/a2a/metrics` | GET | JSON telemetry snapshot (if enabled) |

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

## TODO / Roadmap

Production-grade async task mode (PRs welcome):

- Persist tasks to disk (replace `InMemoryTaskStore` with a durable store) so `tasks/get` survives gateway restarts
- Provide a streaming-first path (SSE / sendMessageStream) for incremental outputs
- Push notifications support (store + sender) for long-running tasks
- Concurrency limits / queueing for inbound A2A dispatch to protect the OpenClaw gateway
- Observability: structured logs + metrics for task durations/timeouts

Interoperability & transport resilience (PRs welcome):

- Peer health checks + retry/backoff + circuit breaker (per-peer)
- Automatic transport fallback (prefer JSON-RPC by default; fall back between JSON-RPC/REST/GRPC based on failures)
- Cross-implementation compatibility test matrix (ensure interop with other A2A servers/clients)

Security & auth hardening (PRs welcome):

- SSRF protections + allowlists for any URI fetching (needed for file parts)
- File size limits + MIME allowlist + content sniffing
- Token rotation / keyring (accept multiple tokens during rotation window)
- Audit log for inbound/outbound A2A calls (who/when/peer/taskId)

Routing & orchestration (PRs welcome):

- Rule-based routing: choose peer + target OpenClaw agentId based on message type/tags
- Explicit multi-round conversation support (carry context via taskId/contextId)

File / image transfer enhancements (PRs welcome):

- ~~Support A2A `file` parts end-to-end (URI + optional bytes/base64)~~ ✅ Done
- ~~Support A2A `data` parts (structured JSON)~~ ✅ Done
- ~~Agent tool `a2a_send_file` for programmatic file sending~~ ✅ Done
- Extend `a2a-send.mjs` with `--file-uri` / `--file-path` to send `kind:"file"` parts from CLI
- Extract URLs from agent text responses (markdown links, bare URLs) into outbound FileParts
- Plugin-side handling: fetch URI to a temp file (or pass URI through) and dispatch to the target OpenClaw agent with a safe reference
- Security: size limits, mime allowlist, SSRF protections for URI fetches, and redaction of bytes in logs

## License

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
