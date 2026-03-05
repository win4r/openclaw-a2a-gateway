# TOOLS.md A2A Section Template

Append this section to the agent's `TOOLS.md` file, replacing all `<PLACEHOLDERS>` with actual values.

---

```markdown
## A2A Gateway (Agent-to-Agent Communication)

You have an A2A Gateway plugin running on port 18800. You can communicate with peer agents on other servers.

### Peers

| Peer | IP | A2A Endpoint | Auth Token |
|------|-----|--------------|------------|
| <PEER_NAME> | <PEER_IP> | http://<PEER_IP>:18800/a2a/jsonrpc | <PEER_TOKEN> |

### How to send a message to a peer

When the user says "通过 A2A 让 <PEER_NAME> 做 xxx" / "Send to <PEER_NAME>: xxx" / "Ask <PEER_NAME> to ..." or similar, use the exec tool to run:

```bash
curl -s -X POST http://<PEER_IP>:18800/a2a/jsonrpc \
  -H "Authorization: Bearer <PEER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "msg-<unique-id>",
        "role": "user",
        "parts": [{"kind": "text", "text": "YOUR MESSAGE HERE"}]
      }
    },
    "id": "1"
  }'
```

### How to parse the response

The peer agent's reply is at: `result.status.message.parts[0].text`

Extract it with:

```bash
... | python3 -c "import sys,json; r=json.load(sys.stdin); parts=r.get('result',{}).get('status',{}).get('message',{}).get('parts',[]); print(parts[0]['text'] if parts else 'No response')"
```

### Notes

- Always generate a unique messageId (e.g., `msg-$(date +%s)`)
- Allow up to 120s timeout for complex tasks
- If the peer returns an error, check the token and network connectivity
```

---

## Placeholder Reference

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<PEER_NAME>` | Display name of the peer agent | `Server-A` |
| `<PEER_IP>` | IP address reachable from this server | `100.76.43.74` |
| `<PEER_TOKEN>` | The peer's inbound security token | `9489c2c7ce10...` |
| `<unique-id>` | Any unique string per message | Use `$(date +%s)` or UUID |

For multiple peers, add one row per peer to the table.
