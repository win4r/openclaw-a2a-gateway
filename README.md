# OpenClaw A2A Gateway Plugin

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that implements the [A2A (Agent-to-Agent) v0.3.0 protocol](https://github.com/google/A2A), enabling OpenClaw agents to communicate with each other across different servers.

## What It Does

- Exposes an **A2A-compliant endpoint** (JSON-RPC + REST) so other agents can send messages to your OpenClaw agent
- Publishes an **Agent Card** at `/.well-known/agent.json` for peer discovery
- Supports **bearer token authentication** for secure inter-agent communication
- Routes inbound A2A messages to your OpenClaw agent and returns the response
- Allows your agent to **call peer agents** via the A2A protocol

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

Every A2A agent needs an Agent Card that describes itself:

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
curl -s http://localhost:18800/.well-known/agent.json | python3 -m json.tool
```

You should see your Agent Card with name, skills, and URL.

## Adding Peers

To communicate with another A2A agent, add it as a peer:

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "PeerName",
    "agentCardUrl": "http://<PEER_IP>:18800/.well-known/agent.json",
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

### From your OpenClaw agent

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
\```

The script auto-discovers the Agent Card, handles auth, and prints the peer's response text.
```

Then users can say things like:
- "Send to PeerName: what's your status?"
- "Ask PeerName to run a health check"

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
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

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
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Verify both directions

```bash
# From Server A → test Server B's Agent Card
curl -s http://100.10.10.2:18800/.well-known/agent.json

# From Server B → test Server A's Agent Card
curl -s http://100.10.10.1:18800/.well-known/agent.json

# Send a message A → B (using SDK script)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Configuration Reference

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | *required* | Display name for this agent |
| `agentCard.description` | string | — | Human-readable description |
| `agentCard.url` | string | auto | JSON-RPC endpoint URL |
| `agentCard.skills` | array | *required* | List of skills this agent offers |
| `server.host` | string | `0.0.0.0` | Bind address |
| `server.port` | number | `18800` | A2A server port |
| `peers` | array | `[]` | List of peer agents |
| `peers[].name` | string | *required* | Peer display name |
| `peers[].agentCardUrl` | string | *required* | URL to peer's Agent Card |
| `peers[].auth.type` | string | — | `bearer` or `apiKey` |
| `peers[].auth.token` | string | — | Authentication token |
| `security.inboundAuth` | string | `none` | `none` or `bearer` |
| `security.token` | string | — | Token for inbound auth |
| `routing.defaultAgentId` | string | `default` | Agent ID for inbound messages |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent.json` | GET | Agent Card (discovery) |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC (message/send) |

## Troubleshooting

### "Request accepted (no agent dispatch available)"

Your OpenClaw agent has no AI provider configured. Run:

```bash
openclaw config get auth.profiles
```

Make sure at least one auth profile is set up (e.g., `openai-codex`, `anthropic`, etc.).

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

## License

MIT
