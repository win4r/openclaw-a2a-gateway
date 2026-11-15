# Route X/Twitter Read Workflows to a GetXAPI Peer

Use this recipe when one OpenClaw A2A node coordinates general work and a
separate peer owns X/Twitter read traffic through
[GetXAPI](https://github.com/getxapi/getxapi-mcp).

This is the read-backend companion to the TweetClaw recipe in
[`SOCIAL-AUTOMATION-ROUTING.md`](./SOCIAL-AUTOMATION-ROUTING.md). The two
recipes are not mutually exclusive: a deployment can route writes to a
TweetClaw peer and reads to a GetXAPI peer.

## Topology

| Node | Role | Example Agent ID |
|------|------|------------------|
| Coordinator | Receives user requests and routes matching X/Twitter reads | `main` |
| Social-Read | Runs a GetXAPI-backed agent and advertises read skills | `read` |

## 1. Configure GetXAPI on the Social-Read Node

```bash
export GETXAPI_KEY=...
```

The backend is read-only when only `GETXAPI_KEY` is set — read endpoints
(search, profile, timeline, follower graph) work with the API key alone.
Write endpoints additionally require X account auth (`X_AUTH_TOKEN`,
`X_CT0`, `X_TWID`) or an `x_login` flow, which are intentionally not set on
a read-only node. Do not put `GETXAPI_KEY` in A2A messages, Agent Cards,
or shared `TOOLS.md` files.

## 2. Advertise GetXAPI Read Skills in the Agent Card

On the Social-Read node:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Social-Read'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'OpenClaw peer for GetXAPI X/Twitter reads'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.4:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"tweet-advanced-search","name":"tweet-advanced-search","description":"Search tweets via GetXAPI advanced_search"},{"id":"tweet-user-lookup","name":"tweet-user-lookup","description":"Look up users and timelines"},{"id":"tweet-replies","name":"tweet-replies","description":"Fetch replies to a tweet"}]'
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'read'
openclaw gateway restart
```

Verify the public Agent Card:

```bash
curl -s http://100.10.10.4:18800/.well-known/agent-card.json | python3 -m json.tool
```

## 3. Add the Social-Read Peer to the Coordinator

On the Coordinator node:

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Social-Read","agentCardUrl":"http://100.10.10.4:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<SOCIAL_READ_TOKEN>"}}]'
```

## 4. Route Read-Shaped Requests to the GetXAPI Peer

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.rules '[{"name":"x-twitter-reads","match":{"pattern":"\\b(search tweets?|find tweets?|look up|user timeline|replies to|fetch tweet)\\b","skills":["tweet-advanced-search","tweet-user-lookup","tweet-replies"]},"target":{"peer":"Social-Read","agentId":"read"},"priority":90}]'
openclaw gateway restart
```

The pattern matches read-shaped wording such as "search tweets about X",
"look up @user", or "fetch replies to this tweet". Pair with the
TweetClaw routing rule from `SOCIAL-AUTOMATION-ROUTING.md` at a higher
priority if write phrasing should still go to the TweetClaw peer.

## 5. Test Direct Peer Connectivity

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.4:18800 \
  --token <SOCIAL_READ_TOKEN> \
  --agent-id read \
  --message "Reply with your Agent Card name and advertised GetXAPI read skills."
```

## 6. Test the Coordinator Route

On the Coordinator node, invoke `a2a.send` with no `peer` or `name`:

```json
{
  "method": "a2a.send",
  "params": {
    "message": {
      "text": "Search tweets about OpenClaw plugins and summarize the top themes."
    }
  }
}
```

Expected behavior:

- `routing.rules` matches the read wording.
- the cached Social-Read Agent Card skills satisfy the GetXAPI skill match.
- the Coordinator forwards the message to peer `Social-Read` with `agentId`
  `read`.

## GetXAPI Endpoint Reference

- `GET https://api.getxapi.com/twitter/tweet/advanced_search?q=<query>`
- Header: `Authorization: Bearer ${GETXAPI_KEY}`

For write actions, keep routing them to a TweetClaw peer per
`SOCIAL-AUTOMATION-ROUTING.md`. GetXAPI in this recipe stays read-only.
