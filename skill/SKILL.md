---
name: a2a-setup
description: "Install and configure the OpenClaw A2A Gateway plugin for cross-server agent communication. Use when: (1) setting up A2A between two or more OpenClaw instances, (2) user says 'configure A2A', 'set up A2A gateway', 'connect two OpenClaw servers', 'agent-to-agent communication', (3) adding a new A2A peer to an existing setup. Covers: plugin installation, Agent Card configuration, security tokens, peer registration, network setup (Tailscale/LAN), TOOLS.md template for agent awareness, and end-to-end verification."
---

# A2A Gateway Setup

Configure the OpenClaw A2A Gateway plugin for cross-server agent-to-agent communication using the A2A v0.3.0 protocol.

## Prerequisites

- OpenClaw ≥ 2026.3.0 installed and running on each server
- Network connectivity between servers (Tailscale recommended, LAN or public IP also work)
- Node.js ≥ 22

## Step 1: Install the Plugin

```bash
mkdir -p <WORKSPACE>/plugins
cd <WORKSPACE>/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

Replace `<WORKSPACE>` with the agent workspace path. Find it with:

```bash
openclaw config get agents.defaults.workspace
```

## Step 2: Register Plugin in OpenClaw

Get current allowed plugins first to avoid overwriting:

```bash
openclaw config get plugins.allow
```

Then add `a2a-gateway` to the existing array:

```bash
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'
openclaw config set plugins.load.paths '["<ABSOLUTE_PATH>/plugins/a2a-gateway"]'
openclaw config set plugins.entries.a2a-gateway.enabled true
```

**Critical:** Use the absolute path in `plugins.load.paths`. Relative paths will fail.

## Step 3: Configure Agent Card

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name '<AGENT_NAME>'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description '<DESCRIPTION>'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<REACHABLE_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

### URL field rules

| Field | Points to | Example |
|-------|-----------|---------|
| `agentCard.url` | JSON-RPC endpoint | `http://100.x.x.x:18800/a2a/jsonrpc` |
| `peers[].agentCardUrl` | Agent Card discovery | `http://100.x.x.x:18800/.well-known/agent.json` |

**Do NOT confuse these two.** `agentCard.url` tells peers where to send messages. `agentCardUrl` tells you where to discover the peer.

## Step 4: Configure Server

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

## Step 5: Configure Security

```bash
TOKEN=$(openssl rand -hex 24)
echo "Save this token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

Share this token with peers who need to send you messages.

## Step 6: Configure Routing

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

## Step 7: Add Peers

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "<PEER_NAME>",
    "agentCardUrl": "http://<PEER_IP>:18800/.well-known/agent.json",
    "auth": {
      "type": "bearer",
      "token": "<PEER_INBOUND_TOKEN>"
    }
  }
]'
```

For multiple peers, include all in one JSON array.

## Step 8: Restart and Verify

```bash
openclaw gateway restart

# Verify Agent Card
curl -s http://localhost:18800/.well-known/agent.json | python3 -m json.tool

# Verify peer connectivity
curl -s http://<PEER_IP>:18800/.well-known/agent.json | python3 -m json.tool
```

## Step 9: Configure TOOLS.md

**This step is critical.** Without it, the agent won't know how to use A2A.

Read `references/tools-md-template.md` and append the A2A section to the agent's `TOOLS.md`, replacing placeholders with actual peer info.

## Step 10: End-to-End Test

Send a test message to verify the full chain:

```bash
curl -s -X POST http://<PEER_IP>:18800/a2a/jsonrpc \
  -H "Authorization: Bearer <PEER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "test-'$(date +%s)'",
        "role": "user",
        "parts": [{"kind": "text", "text": "Hello, what is your name?"}]
      }
    },
    "id": "1"
  }'
```

The response should contain the peer agent's reply at `result.status.message.parts[0].text`.

## Network: Tailscale Setup (if needed)

When servers are on different networks, use Tailscale:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Authenticate via the printed URL (use same account on all servers)
tailscale ip -4  # Get the 100.x.x.x IP
```

Use Tailscale IPs in all A2A configuration. Verify with:

```bash
ping <OTHER_SERVER_TAILSCALE_IP>
```

## Mutual Peering Checklist

For two-way communication, repeat Steps 1-9 on BOTH servers:

- [ ] Server A: plugin installed, Agent Card configured, token generated
- [ ] Server B: plugin installed, Agent Card configured, token generated
- [ ] Server A: has Server B in peers (with B's token)
- [ ] Server B: has Server A in peers (with A's token)
- [ ] Server A: TOOLS.md updated with Server B peer info
- [ ] Server B: TOOLS.md updated with Server A peer info
- [ ] Both: `openclaw gateway restart` done
- [ ] Both: Agent Cards accessible (`curl /.well-known/agent.json`)
- [ ] Test: A → B message/send works
- [ ] Test: B → A message/send works

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "no agent dispatch available" | No AI provider configured | Run `openclaw config get auth.profiles` and set up a provider |
| "plugin not found: a2a-gateway" | Load path missing or wrong | Verify `plugins.load.paths` uses absolute path |
| Agent Card 404 | Plugin not loaded | Check `plugins.allow` includes `a2a-gateway` |
| Port 18800 connection refused | Gateway not restarted | Run `openclaw gateway restart` |
| Peer auth fails | Token mismatch | Verify peer config token matches target's `security.token` |
| Agent doesn't know about A2A | TOOLS.md not configured | Add A2A section from the template (Step 9) |
