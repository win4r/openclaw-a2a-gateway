

## 如何在反向代理后工作

为了避免开放过多端口到互联网，OpenClaw 建议使用 Tailscale 私有虚拟网络或将服务通过反向代理发布。A2A gateway 同样也践行这一安全实践建议。

### 反向代理示例

要尽可能的减少端口暴露，例如将 OpenClaw 默认的 18789 端口，以及 A2A gateway 默认的 18800，18801 端口隐藏在单一互联网 IP 之后，同时启用基于证书的 SSL，以避免 OpenClaw 和 A2A gateway 的 HTTP、JSONRPC 等流量明文暴露，可以选择能够自动申请并维护证书的反向代理工具。以下以 Caddy 为例，说明如何配置反向代理。

对于同一互联网 IP/主机地址 FQDN 能够支持多个服务终结点/端口，可以使用子域名或后接路径转发到特定服务终结点/端口的方式进行互联网 IP/主机地址 FQDN 的复用。在实践中一般不使用太多子域名，而且支持多个子域名需要使用多个证书或通配符证书，因此使用指定路径来重定向的方式实现更容易。

示例采用如下假设：服务全部使用默认端口，OpenClaw 为 18789 端口，A2A gateway 为 18800，18801 端口。互联网IP为 'a.b.c.d'，对应FQDN为 'ai.domain.com'，可操作域名为 'domain.com'。
将 https://ai.domain.com/openclaw 的访问请求转发到本地 18789 端口。将 https://ai.domain.com/.well-known/agent-card.json 和以 /a2a/ 开始的多个路径（可参考README.md中的说明）重定向到18800 端口，将 gRPC 重定向到本地 18801 端口。

应用时请自行修改为实际值。

#### 安装Caddy

如前所述，Caddy会帮助自动申请和更新证书，所以需要安装必要的依赖。安装需要更新软件包的密钥和源。

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

#### 配置Caddy

安装完成后，需要对 Caddy 的反向代理规则进行配置，方法是编辑配置文件 Caddyfile。

```bash
sudo nano /etc/caddy/Caddyfile
```

以下是示例配置文件：

```
ai.domain.com {
    # forward all path start with /openclaw to local port 18789
	handle_path /openclaw* {
		reverse_proxy localhost:18789
	}
    # define gRPC communication
	@a2a_grpc {
		header Content-Type application/grpc*
	}
    # reverse proxy gRPC to local port 18801 as H2C
	reverse_proxy @a2a_grpc h2c://localhost:18801
    # define JSONRPC and REST paths
	@a2a_paths {
		path /.well-known/agent-card.json
		path /a2a/*
	}
    # reverse proxy to local port 18800
	handle @a2a_paths {
		reverse_proxy localhost:18800
	}
    # handle other to defualt path
	handle {
		root * /usr/share/caddy
		file_server
	}
}
```

handle_path 会“吃掉”路径 /openclaw* ，然后再转发到本地 18789 端口。handle 会原样转发到本地 18800 端口。gRPC 的通信通常只包括主机名和端口，因此无法通过路径来路由，但可以根据请求头部的定义 ‘Content-Type application/grpc*’ 来进行。请注意当前配置会将默认 443 端口的所有 gRPC 流量都重定向到本地 18801 端口。如果还有其他的 gRPC 通信，可以参考使用包名、服务名和方法名（格式通常为 /PackageName.ServiceName/MethodName）进行流量拆分。

修改完毕后，对配置文件进行校验。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

如果校验通过，就可以重载或重启 Caddy 让配置生效。

```bash
sudo systemctl daemon-reload
sudo systemctl restart caddy
```
#### 验证反向代理

检验 Caddy 的反向代理是否生效也很简单，可以使用 curl。

```bash
curl -s https://ai.domain.com/.well-known/agent-card.json | python3 -m json.tool
```

如果能和之前一样显示 agent card 的配置，就说明 JSONRPC 和 REST 流量基本正常了。gRPC流量可以使用 grpcurl 来测试。

```bash
# install grpcurl if haven't yet
curl -L -O https://github.com/fullstorydev/grpcurl/releases/download/v1.9.3/grpcurl_1.9.3_linux_x86_64.tar.gz
tar -xvf grpcurl_1.9.3_linux_x86_64.tar.gz
sudo mv grpcurl /usr/local/bin/
# test local grpc service
grpcurl -plaintext localhost:18801 list
# test grpc after reverse proxy
grpcurl ai.domain.com list
```
看到 ‘Failed to list services: server does not support the reflection API’ 而非其他错误时，gRPC 的访问应该是正常的，因为目前没有对服务进行反射。

#### 更新 OpenClaw 和 A2A gaetway 配置

测试反向代理工作正常后，需要更新 OpenClaw 的 Gateway 的配置，在 gateway.controlUi.allowedOrigins 的配置中加入 "https://ai.domain.com" 。如果使用了非默认的 443 端口，例如 444 端口，则加入 "https://ai.domain.com:444" 。使得 OpenClaw 能够接受并处理请求。

也需要更新 A2A gateway 的配置。在本地侧：
```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'https://ai.domain.com/a2a/jsonrpc'
```
请注意该配置与 REAMME.md 中 'http://<YOUR_IP>:18800/a2a/jsonrpc' 的差别。同样，如果不使用默认 443 端口而是用例如 444 端口：
```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'https://ai.domain.com:444/a2a/jsonrpc'
```
还需要为 gRPC 启用反向代理支持：
```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.grpcProxy true
```
将 OpenClaw gateway 服务重启后，可以使用 curl 显示 agent-card.json 确认更改生效。
```bash
openclaw gateway restart
curl -s https://ai.domain.com/.well-known/agent-card.json | python3 -m json.tool
```
注意返回 JSON 信息中有关的 URL 是否更新。

最后，不要忘记在对端 Agent 平台更新 A2A gateway 的 Peer 信息：
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

### 其他建议

在常见场景中，由本地的 Agent 通过 A2A 协议协调远端的 Agent，远端 Agent 可能持续运行在云中，以上反向代理设置应该正常工作。但如果本地 Agent 通过运行商接入互联网，就可能有两个限制：

- 1、没有提供固定公网 IP 甚至没有公网 IP
- 2、限制发布 80/443 端口到公网

建议的处理方式：
- 1、首先致电运营商，说明要远程访问家中视频监控，请求一个真正的公网 IP。通常运营商不可能提供固定的公网 IP，因此需要通过动态 DNS 方式来保持域名能够解析为更新的 IP 地址。可以使用 DDNS 服务（可能收费），也可以借助 Caddy 的动态解析插件，支持 Ali DNS、Cloudflare 等平台自动更新 DNS 解析。安装编译插件需要使用 xcaddy，可自行搜索配置。
- 2、限制端口会带来两个问题：
    - 2.1、Caddy 无法申请和更新证书，因为申请证书需要验证 80/443 端口

        解决这个问题可以通过 DNS-01 挑战代替默认的 HTTP 或 TLS-ALPN 挑战来解决。这一方式也适用于申请通配符证书。需要通过 xcaddy 编译安装动态 DNS 插件，例如 alidns，然后配置服务及 Caddyfile 通过例如 alidns 的凭据，创建或刷新特殊的 TXT 记录来验证域名所有权，然后颁发或更新证书。 
    - 2.2、无法通过默认 443 端口访问 OpenClaw、A2A gateway
    
        可以通过端口映射。例如在上网路由器（例如光猫）上找到 NAT 配置，将公网 IP 的 444 端口映射到内网 Agent 主机 IP 的 443 端口。这时。需要修改 OpenClaw 和 A2A gateway 的设置，确保 url 带上指定端口，例如：ai.domain.com:444 。



