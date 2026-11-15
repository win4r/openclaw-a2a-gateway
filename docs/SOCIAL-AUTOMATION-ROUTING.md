# Route X/Twitter Workflows to a TweetClaw Peer

Use this recipe when one OpenClaw A2A node coordinates general work and a
separate peer owns X/Twitter automation through
[TweetClaw](https://github.com/Xquik-dev/tweetclaw).

This keeps social automation credentials on the social peer while the
coordinator can still route requests such as tweet search, reply search,
posting drafts, follower export, media upload/download, monitors, webhooks, and
giveaway draws.

## Topology

| Node | Role | Example Agent ID |
|------|------|------------------|
| Coordinator | Receives user requests and routes matching X/Twitter work | `main` |
| Social-Ops | Runs TweetClaw and advertises X/Twitter skills | `social` |

## 1. Install TweetClaw on the Social-Ops Node

```bash
openclaw plugins install @xquik/tweetclaw
```

Configure TweetClaw/Xquik credentials on this node only. Do not put API keys in
A2A messages, Agent Cards, or shared `TOOLS.md` files.

## 2. Advertise TweetClaw Capabilities in the Agent Card

On the Social-Ops node:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Social-Ops'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'OpenClaw peer for TweetClaw X/Twitter automation'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.3:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"tweet-search","name":"tweet-search","description":"Search tweets and tweet replies"},{"id":"tweet-post","name":"tweet-post","description":"Draft and post tweets or tweet replies with approval"},{"id":"tweet-followers","name":"tweet-followers","description":"Export followers and run user lookup"},{"id":"tweet-media","name":"tweet-media","description":"Upload and download tweet media"},{"id":"tweet-monitor","name":"tweet-monitor","description":"Monitor tweets, webhooks, and giveaway draws"}]'
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'social'
openclaw gateway restart
```

Verify the public Agent Card:

```bash
curl -s http://100.10.10.3:18800/.well-known/agent-card.json | python3 -m json.tool
```

## 3. Add the Social-Ops Peer to the Coordinator

On the Coordinator node:

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Social-Ops","agentCardUrl":"http://100.10.10.3:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<SOCIAL_OPS_TOKEN>"}}]'
```

## 4. Route Matching Requests by Pattern and Peer Skills

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.rules '[{"name":"x-twitter-automation","match":{"pattern":"\\b(tweet|tweets|reply|replies|twitter|x/twitter|x api|follower|followers|user lookup|media|direct messages?|dms?|webhook|giveaway)\\b","skills":["tweet-search","tweet-post","tweet-monitor","tweet-followers","tweet-media"]},"target":{"peer":"Social-Ops","agentId":"social"},"priority":100}]'
openclaw gateway restart
```

The rule is intentionally broad enough for user language such as "search tweets
about OpenClaw", "post this reply", "export followers", "monitor this account",
"send a direct message", or "run a giveaway draw".

## 5. Test Direct Peer Connectivity

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.3:18800 \
  --token <SOCIAL_OPS_TOKEN> \
  --agent-id social \
  --message "Reply with your Agent Card name and advertised TweetClaw skills."
```

This only proves the Social-Ops peer is reachable. It does not exercise the
Coordinator routing rule.

## 6. Test the Coordinator Route

On the Coordinator node, invoke the OpenClaw gateway method `a2a.send` with no
`peer` or `name` parameter:

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

Use the Coordinator gateway endpoint and Coordinator gateway auth token for this
request, not the Social-Ops A2A endpoint or token. Expected behavior:

- `routing.rules` matches the tweet search wording.
- the cached Social-Ops Agent Card skills satisfy the TweetClaw skill match.
- the Coordinator forwards the message to peer `Social-Ops` with `agentId`
  `social`.

Do not include `peer` or `name` while testing routing. Explicit peer selection
bypasses routing rules and can hide a broken rule.

For write actions, ask the Social-Ops peer to draft first and request explicit
approval before posting.
