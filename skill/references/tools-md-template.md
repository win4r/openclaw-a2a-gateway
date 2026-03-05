# TOOLS.md A2A Section Template

Append this section to the agent's `TOOLS.md` file, replacing all `<PLACEHOLDERS>` with actual values.

---

```markdown
## A2A Gateway (Agent-to-Agent Communication)

You have an A2A Gateway plugin running on port 18800. You can communicate with peer agents on other servers.

### Peers

| Peer | IP | Auth Token |
|------|-----|------------|
| <PEER_NAME> | <PEER_IP> | <PEER_TOKEN> |

### How to send a message to a peer

When the user says "通过 A2A 让 <PEER_NAME> 做 xxx" / "Send to <PEER_NAME>: xxx" / "Ask <PEER_NAME> to ..." or similar, use the exec tool to run:

```bash
node <WORKSPACE>/plugins/a2a-gateway/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "YOUR MESSAGE HERE"

# Optional (OpenClaw extension): route to a specific peer OpenClaw agentId
#  --agent-id coder
```

The script uses `@a2a-js/sdk` ClientFactory to:
- Auto-discover the peer's Agent Card
- Handle bearer token authentication
- Select the best transport (JSON-RPC by default; REST or GRPC if preferred/available)
- Print the peer agent's response text directly

### Notes

- Allow up to 120s timeout for complex tasks
- If the peer returns an error, check the token and network connectivity
- The script handles messageId generation and response parsing automatically
```

---

## Placeholder Reference

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<PEER_NAME>` | Display name of the peer agent | `Server-A` |
| `<PEER_IP>` | IP address reachable from this server | `100.76.43.74` |
| `<PEER_TOKEN>` | The peer's inbound security token | `9489c2c7ce10...` |
| `<WORKSPACE>` | Agent workspace absolute path | `/home/ubuntu/.openclaw/workspace` |

For multiple peers, add one row per peer to the table.
