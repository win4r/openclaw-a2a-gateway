# OpenClaw A2A Gateway 插件

[OpenClaw](https://github.com/openclaw/openclaw) 插件，实现 [A2A (Agent-to-Agent) v0.3.0 协议](https://github.com/google/A2A)，让不同服务器上的 OpenClaw Agent 互相通信。

## 功能

- 暴露 **A2A 标准端点**（JSON-RPC + REST），其他 Agent 可以发消息给你的 Agent
- 在 `/.well-known/agent.json` 发布 **Agent Card**，支持对等发现
- 支持 **Bearer Token 认证**，确保安全的跨 Agent 通信
- 将入站 A2A 消息路由到你的 OpenClaw Agent 并返回响应
- 你的 Agent 也可以 **主动调用对等 Agent**

## 架构

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw 服务器 A   │ ◄──────────────────────────► │    OpenClaw 服务器 B   │
│                       │      (Tailscale / 内网)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A 端口: 18800       │                               │  A2A 端口: 18800       │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## 前提条件

- **OpenClaw** ≥ 2026.3.0 已安装并运行
- 服务器之间有 **网络连通性**（Tailscale、局域网或公网 IP）
- **Node.js** ≥ 22

## 安装步骤

### 1. 克隆插件

```bash
# 放到 workspace 的 plugins 目录
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. 在 OpenClaw 中注册插件

```bash
# 添加到允许列表
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# 设置插件路径
openclaw config set plugins.load.paths '["<插件绝对路径>/plugins/a2a-gateway"]'

# 启用插件
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **注意：** `<插件绝对路径>` 替换为实际路径，如 `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`。`plugins.allow` 数组要保留已有的插件。

### 3. 配置 Agent Card

每个 A2A Agent 都需要一个描述自身的 Agent Card：

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name '我的Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description '我的 OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<你的IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
```

> **重要：** `<你的IP>` 替换为对等方可达的 IP（Tailscale IP、内网 IP 或公网 IP）。

### 4. 配置 A2A 服务器

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. 配置安全认证（推荐）

生成入站认证 Token：

```bash
TOKEN=$(openssl rand -hex 24)
echo "你的 A2A Token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> 保存好这个 Token —— 对等方连接你时需要用到。

### 6. 配置 Agent 路由

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. 重启网关

```bash
openclaw gateway restart
```

### 8. 验证

```bash
# 检查 Agent Card 是否可访问
curl -s http://localhost:18800/.well-known/agent.json | python3 -m json.tool
```

你应该能看到包含 name、skills 和 URL 的 Agent Card。

## 添加对等方 (Peers)

要与另一个 A2A Agent 通信，将其添加为 Peer：

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "对等方名称",
    "agentCardUrl": "http://<对等方IP>:18800/.well-known/agent.json",
    "auth": {
      "type": "bearer",
      "token": "<对等方Token>"
    }
  }
]'
```

然后重启：

```bash
openclaw gateway restart
```

### 双向配对

要实现双向通信，**两台服务器** 都要把对方添加为 Peer：

| 服务器 A | 服务器 B |
|----------|----------|
| Peer: Server-B（用 B 的 Token） | Peer: Server-A（用 A 的 Token） |

每台服务器生成自己的安全 Token，分享给对方。

## 通过 A2A 发送消息

### 命令行方式

```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<对等方IP>:18800 \
  --token <对等方Token> \
  --message "你好，来自服务器A！"
```

脚本使用 `@a2a-js/sdk` ClientFactory 自动发现 Agent Card 并选择最佳传输协议。

### 指定路由到某个 OpenClaw agentId（OpenClaw 扩展）

默认情况下，对端会把入站 A2A 消息路由到 `routing.defaultAgentId`（通常是 `main`）。

如果你希望“这一条消息”路由到对端某个特定的 OpenClaw `agentId`（例如 `coder`），可以加 `--agent-id`：

```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<对等方IP>:18800 \
  --token <对等方Token> \
  --agent-id coder \
  --message "跑一遍测试并汇总结果"
```

这是通过非标准字段 `message.agentId` 实现的（本插件支持）。该方式在 JSON-RPC/REST 上最可靠；gRPC 传输可能会丢弃未知 Message 字段。

### 让你的 Agent 知道如何调用（TOOLS.md 模板）

在 Agent 的 `TOOLS.md` 中添加以下内容（完整模板见 `skill/references/tools-md-template.md`），Agent 就能自主调用 A2A：

```markdown
## A2A Gateway（Agent 间通信）

你有一个 A2A Gateway 插件运行在 18800 端口。

### 对等方列表

| 对等方 | IP | 认证 Token |
|--------|-----|------------|
| PeerName | <PEER_IP> | <PEER_TOKEN> |

### 发送消息给对等方

当用户说 "通过 A2A 让 PeerName 做 xxx" 或 "发给 PeerName：xxx" 时，用 exec 工具执行：

\```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "你的消息内容"

# 可选（OpenClaw 扩展）：路由到对端特定 agentId
#  --agent-id coder
\```

脚本自动发现 Agent Card、处理认证、并输出对方的回复文本。
```

配好后用户就可以这样说：
- "通过 A2A 让 PeerName 查一下系统状态"
- "发给 PeerName：你叫什么名字？"

## 网络配置

### 方案 A：Tailscale（推荐）

[Tailscale](https://tailscale.com/) 在服务器之间创建安全的 Mesh 网络，无需防火墙配置。

```bash
# 两台服务器都装
curl -fsSL https://tailscale.com/install.sh | sh

# 用同一个账号认证
sudo tailscale up

# 查看状态
tailscale status
# 你会看到每台机器的 100.x.x.x IP

# 测试连通性
ping <对方的Tailscale_IP>
```

在 A2A 配置中使用 `100.x.x.x` 的 Tailscale IP。流量端对端加密。

### 方案 B：局域网

两台服务器在同一局域网内，直接用内网 IP。确保 18800 端口可访问。

### 方案 C：公网 IP

使用公网 IP + Bearer Token 认证。建议用防火墙限制来源 IP。

## 完整示例：两台服务器配对

### 服务器 A 配置

```bash
# 生成 A 的 Token
A_TOKEN=$(openssl rand -hex 24)
echo "服务器 A Token: $A_TOKEN"

# 配置 A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# 添加 B 为 Peer（用 B 的 Token）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### 服务器 B 配置

```bash
# 生成 B 的 Token
B_TOKEN=$(openssl rand -hex 24)
echo "服务器 B Token: $B_TOKEN"

# 配置 A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# 添加 A 为 Peer（用 A 的 Token）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### 双向验证

```bash
# 服务器 A → 测试 B 的 Agent Card
curl -s http://100.10.10.2:18800/.well-known/agent.json

# 服务器 B → 测试 A 的 Agent Card
curl -s http://100.10.10.1:18800/.well-known/agent.json

# 发消息 A → B（使用 SDK 脚本）
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "你好，来自服务器A！"
```

## 配置参考

| 配置路径 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `agentCard.name` | string | *必填* | Agent 显示名称 |
| `agentCard.description` | string | — | 人类可读的描述 |
| `agentCard.url` | string | 自动 | JSON-RPC 端点 URL |
| `agentCard.skills` | array | *必填* | Agent 提供的技能列表 |
| `server.host` | string | `0.0.0.0` | 绑定地址 |
| `server.port` | number | `18800` | A2A 服务端口 |
| `peers` | array | `[]` | 对等 Agent 列表 |
| `peers[].name` | string | *必填* | 对等方显示名称 |
| `peers[].agentCardUrl` | string | *必填* | 对等方 Agent Card URL |
| `peers[].auth.type` | string | — | `bearer` 或 `apiKey` |
| `peers[].auth.token` | string | — | 认证 Token |
| `security.inboundAuth` | string | `none` | `none` 或 `bearer` |
| `security.token` | string | — | 入站认证 Token |
| `routing.defaultAgentId` | string | `default` | 入站消息路由到的 Agent ID |

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/agent.json` | GET | Agent Card（发现） |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC（message/send） |

## 常见问题

### "Request accepted (no agent dispatch available)"

你的 OpenClaw Agent 没有配置 AI Provider。检查：

```bash
openclaw config get auth.profiles
```

确保至少配了一个认证 profile（如 `openai-codex`、`anthropic` 等）。

### Agent Card 返回 404

插件没加载。检查：

```bash
# 确认插件在允许列表中
openclaw config get plugins.allow

# 确认加载路径正确
openclaw config get plugins.load.paths

# 查看网关日志
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### 18800 端口连接被拒

```bash
# 检查 A2A 服务是否在监听
ss -tlnp | grep 18800

# 如果没有，重启网关
openclaw gateway restart
```

### 对等方认证失败

确保你的 peer 配置中的 token 和目标服务器的 `security.token` 完全一致。

## Agent Skill（适用于 OpenClaw / Codex CLI）

本仓库在 `skill/` 目录下包含一个开箱即用的 **skill**，可以引导 AI agent（OpenClaw、Codex CLI、Claude Code 等）一步步完成 A2A 的完整配置流程 —— 包括安装、配置、Peer 注册、TOOLS.md 设置和验证。

### 为什么要用 skill？

手动配置 A2A 涉及很多步骤，字段名、URL 格式和 Token 处理都容易出错。Skill 把这些编码成可重复的流程，避免常见错误：

- 混淆 `agentCard.url`（JSON-RPC 端点）和 `peers[].agentCardUrl`（Agent Card 发现地址）
- 忘记更新 TOOLS.md（导致 agent 不知道如何调用 peer）
- `plugins.load.paths` 用了相对路径（必须用绝对路径）
- 忘了双向配对（两边都要把对方加为 peer）

### 安装 skill

**OpenClaw：**

```bash
cp -r <仓库路径>/skill ~/.openclaw/workspace/skills/a2a-setup
# 或软链接
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Codex CLI：**

```bash
cp -r <仓库路径>/skill ~/.codex/skills/a2a-setup
```

**Claude Code：**

```bash
cp -r <仓库路径>/skill ./skills/a2a-setup
```

### Skill 内容

```
skill/
├── SKILL.md                          # 分步配置指南
├── scripts/
│   └── a2a-send.mjs                  # 基于 SDK 的消息发送脚本（官方 @a2a-js/sdk）
└── references/
    └── tools-md-template.md          # TOOLS.md 模板，让 agent 知道如何调用 A2A
```

Skill 提供两种 agent 调用方式：
- **curl** — 通用，任何环境都能用
- **SDK 脚本** — 使用 `@a2a-js/sdk` ClientFactory，自动发现 Agent Card 和选择传输协议

### 使用方式

安装后，跟你的 agent 说：

- "配置 A2A gateway" / "Set up A2A"
- "把这台 OpenClaw 通过 A2A 连接到另一台服务器"
- "添加一个 A2A peer"

Agent 会自动按照 skill 的流程执行。

## 许可证

MIT
