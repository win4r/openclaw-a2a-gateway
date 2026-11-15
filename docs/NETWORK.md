## Working Behind a Reverse Proxy

To avoid exposing too many ports to the public internet, OpenClaw recommends using a private Tailscale network or publishing services through a reverse proxy. The A2A gateway follows the same security practice.

### Reverse Proxy Example

To minimize exposed ports, you may want to hide OpenClaw's default port `18789` and the A2A gateway's default ports `18800` and `18801` behind a single public IP, while also enabling TLS so that OpenClaw and A2A gateway HTTP / JSON-RPC traffic is not exposed in plaintext. In that case, a reverse proxy that can automatically issue and renew certificates is a good choice. The example below uses Caddy.

When a single public IP / FQDN serves multiple endpoints or backend ports, you can either use subdomains or route by path. In practice, using many subdomains is often inconvenient, and supporting multiple subdomains may require multiple certificates or a wildcard certificate. Path-based routing is usually simpler.

This example assumes all services use their default ports: OpenClaw on `18789`, and A2A gateway on `18800` and `18801`. The public IP is `a.b.c.d`, the public FQDN is `ai.domain.com`, and the controllable root domain is `domain.com`.

The setup forwards:

- `https://ai.domain.com/openclaw` to local port `18789`
- `https://ai.domain.com/.well-known/agent-card.json` and all `/a2a/` paths to local port `18800`
- gRPC traffic to local port `18801`

Adjust the example to match your real deployment.

#### Install Caddy

As noted above, Caddy can automatically issue and renew certificates, so install the required dependencies first by updating the package keys and repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

#### Configure Caddy

After installation, edit the Caddy reverse proxy rules in `Caddyfile`:

```bash
sudo nano /etc/caddy/Caddyfile
```

Example configuration:

```caddy
ai.domain.com {
    # forward all paths starting with /openclaw to local port 18789
    handle_path /openclaw* {
        reverse_proxy localhost:18789
    }

    # detect gRPC traffic
    @a2a_grpc {
        header Content-Type application/grpc*
    }

    # proxy gRPC to local port 18801 using H2C
    reverse_proxy @a2a_grpc h2c://localhost:18801

    # define JSON-RPC and REST paths
    @a2a_paths {
        path /.well-known/agent-card.json
        path /a2a/*
    }

    # proxy HTTP traffic to local port 18800
    handle @a2a_paths {
        reverse_proxy localhost:18800
    }

    # handle everything else with the default site
    handle {
        root * /usr/share/caddy
        file_server
    }
}
```

`handle_path` strips the `/openclaw*` prefix before forwarding to local port `18789`. `handle` forwards the original path to local port `18800`. gRPC usually only includes host and port information, so it normally cannot be routed by path, but it can be matched by the `Content-Type: application/grpc*` header. Note that the current example redirects **all** gRPC traffic on the default `443` port to local port `18801`. If you also host other gRPC services, you can split traffic further by package name, service name, and method name (typically in the form `/PackageName.ServiceName/MethodName`).

After editing, validate the configuration:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

If validation succeeds, reload or restart Caddy:

```bash
sudo systemctl daemon-reload
sudo systemctl restart caddy
```

#### Verify the Reverse Proxy

You can verify the reverse proxy with `curl`:

```bash
curl -s https://ai.domain.com/.well-known/agent-card.json | python3 -m json.tool
```

If the Agent Card is displayed correctly, JSON-RPC and REST traffic are probably working. Use `grpcurl` to test gRPC:

```bash
# install grpcurl if needed
curl -L -O https://github.com/fullstorydev/grpcurl/releases/download/v1.9.3/grpcurl_1.9.3_linux_x86_64.tar.gz
tar -xvf grpcurl_1.9.3_linux_x86_64.tar.gz
sudo mv grpcurl /usr/local/bin/

# test the local gRPC service
grpcurl -plaintext localhost:18801 list

# test gRPC through the reverse proxy
grpcurl ai.domain.com list
```

If you see `Failed to list services: server does not support the reflection API` instead of some other error, gRPC access is probably working correctly, because service reflection is not currently enabled.

#### Update OpenClaw and A2A Gateway Configuration

After confirming that the reverse proxy works, update the OpenClaw gateway configuration by adding `"https://ai.domain.com"` to `gateway.controlUi.allowedOrigins`. If you use a non-default public port such as `444`, add `"https://ai.domain.com:444"` instead so OpenClaw will accept and process requests.

You also need to update the A2A gateway configuration on the local side:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'https://ai.domain.com/a2a/jsonrpc'
```

Note the difference from the README example `http://<YOUR_IP>:18800/a2a/jsonrpc`. If you use a non-default public port, such as `444`, then:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'https://ai.domain.com:444/a2a/jsonrpc'
```

You also need to enable gRPC reverse proxy support:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.grpcProxy true
```

Restart the OpenClaw gateway service, then use `curl` to verify that the Agent Card reflects the update:

```bash
openclaw gateway restart
curl -s https://ai.domain.com/.well-known/agent-card.json | python3 -m json.tool
```

Check whether the relevant URLs in the returned JSON have been updated.

Finally, do not forget to update the peer information on the remote Agent platform:

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "PeerName",
    "agentCardUrl": "https://ai.domain.com/.well-known/agent-card.json",
    "auth": {
      "type": "bearer",
      "token": "<PEER_TOKEN>"
    }
  }
]'
```

### Additional Suggestions

In common scenarios, a local agent coordinates remote agents over A2A, while the remote agents run continuously in the cloud. The reverse proxy setup above should work well. But if your local agent reaches the internet through a residential ISP, you may run into two limitations:

- no fixed public IP, or even no public IP at all
- restrictions on exposing ports `80` / `443` to the public internet

Recommended approaches:

1. Contact your ISP and explain that you need remote access to home video surveillance. Ask for a real public IP. In many cases the ISP still will not provide a fixed IP, so you may need dynamic DNS to keep your domain pointing to the current address. You can use a paid DDNS service, or use Caddy with a dynamic DNS plugin for providers such as AliDNS or Cloudflare. Plugin builds require `xcaddy`; search for the setup that matches your provider.

2. Port restrictions introduce two practical problems:

   1. **Caddy cannot issue or renew certificates**, because certificate issuance normally validates ports `80` / `443`.

      You can solve this by using a DNS-01 challenge instead of the default HTTP or TLS-ALPN challenge. This approach also works for wildcard certificates. You will need to build Caddy with a dynamic DNS plugin such as `alidns` using `xcaddy`, then configure the service and `Caddyfile` so that Caddy can create or refresh the required TXT records and validate domain ownership before issuing or renewing certificates.

   2. **You cannot access OpenClaw or A2A gateway through the default public port `443`.**

      You can use port forwarding. For example, in your router or modem NAT settings, map public port `444` to port `443` on the internal host that runs the agent. In that case, update OpenClaw and A2A gateway configuration so the URLs include the custom public port, for example `ai.domain.com:444`.
