# OpenClaw A2A Gateway 插件

[OpenClaw](https://github.com/openclaw/openclaw) 插件，实现 [A2A (Agent-to-Agent) v0.3.0 协议](https://github.com/google/A2A)，让不同服务器上的 OpenClaw Agent 互相通信。

## 功能

- 暴露 **A2A 标准端点**（JSON-RPC + REST），其他 Agent 可以发消息给你的 Agent
- 在 `/.well-known/agent-card.json` 发布 **Agent Card**，支持对等发现（兼容别名：`/.well-known/agent.json`）
- 支持 **Bearer Token 认证**，确保安全的跨 Agent 通信
- 将入站 A2A 消息路由到你的 OpenClaw Agent 并返回响应
- 你的 Agent 也可以 **主动调用对等 Agent**
- 端到端支持 **A2A Part 类型**：`TextPart`、`FilePart`（URI + base64）、`DataPart`（结构化 JSON）
- 提供 **`a2a_send_file` Agent 工具**，让 Agent 能以编程方式发送文件给 Peer

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

### 快速开始（零配置）

插件内置了合理的默认值 —— **无需任何手动配置**即可安装并加载：

```bash
# 克隆
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# 注册并启用
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# 重启
openclaw gateway restart

# 验证
openclaw plugins list          # 应该能看到 a2a-gateway 已加载
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

插件会以默认 Agent Card 启动（`name: "OpenClaw A2A Gateway"`，`skills: [chat]`）。后续可按需自定义 —— 见下方 [配置 Agent Card](#3-配置-agent-card)。

### 分步安装

如果你需要手动控制或保留已有插件配置：

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

每个 A2A Agent 都需要一个描述自身的 Agent Card。如果跳过此步骤，插件使用以下默认值：

| 字段 | 默认值 |
|------|--------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

自定义配置：

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
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

你应该能看到包含 name、skills 和 URL 的 Agent Card。

## 添加对等方 (Peers)

要与另一个 A2A Agent 通信，将其添加为 Peer：

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "对等方名称",
    "agentCardUrl": "http://<对等方IP>:18800/.well-known/agent-card.json",
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

### 异步 task 模式（推荐用于耗时长的任务）

对于长回复/多轮讨论，建议使用 non-blocking + 轮询：

```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<对等方IP>:18800 \
  --token <对等方Token> \
  --non-blocking \
  --wait \
  --timeout-ms 600000 \
  --poll-ms 1000 \
  --message "用 3 轮讨论 A2A 通信的优势并给出最终结论"
```

该模式会发送 `configuration.blocking=false`，然后通过 `tasks/get` 轮询直到任务进入终态。

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

即使插件已经安装并配置好，LLM agent 也**不会可靠地自动推断**如何调用 A2A peer（peer URL、token、需要执行的命令）。为了让 agent 稳定地发起 **出站** A2A 调用，建议把 A2A 调用方式写入 `TOOLS.md`。

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

## A2A Part 类型

插件支持所有三种 A2A Part 类型的入站消息。由于 OpenClaw Gateway RPC 只接受纯文本，每种 Part 类型都会被序列化为人类可读的格式后再发送给 Agent。

| Part 类型 | 发送给 Agent 的格式 | 示例 |
|-----------|-------------------|------|
| `TextPart` | 原始文本 | `Hello world` |
| `FilePart`（URI） | `[Attached: report.pdf (application/pdf) → https://...]` | 基于 URI 的文件引用 |
| `FilePart`（base64） | `[Attached: photo.png (image/png), inline 45KB]` | 内联文件，带大小提示 |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | 结构化 JSON 数据（超过 2KB 截断） |

出站响应中，插件会将 Agent payload 中的结构化 `mediaUrl`/`mediaUrls` 字段转换为 A2A 响应中的 `FilePart`。

> **注意：** 出站 FilePart 生成依赖 Agent payload 中的结构化 `mediaUrl`/`mediaUrls` 字段。纯文本中嵌入的 URL（如 markdown 链接）不会自动提取为 FilePart。

### a2a_send_file Agent 工具

插件注册了一个 `a2a_send_file` 工具，Agent 可以调用它来发送文件给 Peer：

| 参数 | 必填 | 说明 |
|------|------|------|
| `peer` | 是 | 目标 Peer 名称（需匹配已配置的 Peer） |
| `uri` | 是 | 文件的公开 URL |
| `name` | 否 | 文件名（如 `report.pdf`） |
| `mimeType` | 否 | MIME 类型（省略时从扩展名自动检测） |
| `text` | 否 | 随文件一起发送的可选文本消息 |
| `agentId` | 否 | 路由到 Peer 上特定的 agentId（OpenClaw 扩展） |

示例交互：
- 用户："把测试报告发给 AWS-bot"
- Agent 调用 `a2a_send_file`，参数 `peer: "AWS-bot"`、`uri: "https://..."`、`name: "report.pdf"`

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
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

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
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### 双向验证

```bash
# 服务器 A → 测试 B 的 Agent Card
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# 服务器 B → 测试 A 的 Agent Card
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# 发消息 A → B（使用 SDK 脚本）
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "你好，来自服务器A！"
```

## 配置参考

| 配置路径 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Agent 显示名称 |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | 人类可读的描述 |
| `agentCard.url` | string | 自动 | JSON-RPC 端点 URL |
| `agentCard.skills` | array | `[{chat}]` | Agent 提供的技能列表 |
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
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Agent 响应最大等待时间（毫秒） |

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/agent-card.json` | GET | Agent Card（发现） |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC（message/send） |

## 常见问题

### "Request accepted (no agent dispatch available)"

这表示 A2A 网关收到了请求，但底层 OpenClaw agent 的执行没有成功完成。

常见原因：

1) **目标 OpenClaw 实例没有配置 AI Provider**。

```bash
openclaw config get auth.profiles
```

2) **任务耗时过长导致调度超时**。

解决：
- 发送端使用异步 task 模式：`--non-blocking --wait`
- 或提高插件超时：`plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs`（默认 300000）


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

## TODO / 路线图

生产级异步 task 模式（欢迎 PR）：

- 将任务持久化到磁盘（替换 `InMemoryTaskStore`），使 `tasks/get` 在 gateway 重启后不丢
- 提供更适合流式输出的路径（SSE / sendMessageStream）
- Push notifications 支持（store + sender），用于超长任务的异步回调
- 并发限制 / 队列：保护 OpenClaw gateway 不被大量入站 A2A 请求压垮
- 可观测性：结构化日志 + 指标（任务耗时/超时/失败率）

互操作与传输韧性（欢迎 PR）：

- Peer 健康检查 + retry/backoff + 熔断（按 peer 维度）
- 自动传输降级（默认 JSON-RPC；在 JSON-RPC/REST/GRPC 之间按失败情况切换）
- 跨实现兼容性测试矩阵（确保与其他 A2A server/client 互通）

安全与鉴权增强（欢迎 PR）：

- URI fetch 的 SSRF 防护 + allowlist（为 file parts 做准备）
- 文件大小限制 + MIME allowlist + 内容嗅探
- Token 轮换 / keyring（轮换窗口内同时接受多 token）
- 入站/出站 A2A 调用审计日志（who/when/peer/taskId）

路由与编排（欢迎 PR）：

- 规则路由：按消息类型/标签自动选择 peer + 目标 OpenClaw agentId
- 显式多轮对话支持（通过 taskId/contextId 传递上下文）

文件 / 图像传输增强（欢迎 PR）：

- ~~端到端支持 A2A `file` parts（URI + 可选 bytes/base64）~~ ✅ 已完成
- ~~支持 A2A `data` parts（结构化 JSON）~~ ✅ 已完成
- ~~Agent 工具 `a2a_send_file`，编程式发送文件~~ ✅ 已完成
- 扩展 `a2a-send.mjs`：增加 `--file-uri` / `--file-path`，从命令行发送 `kind:"file"` parts
- 从 Agent 文本回复中提取 URL（markdown 链接、裸 URL）为出站 FilePart
- 插件侧处理：下载 URI 到临时文件（或安全透传 URI），再以安全引用的方式交给目标 OpenClaw agent
- 安全：大小限制、mime allowlist、URI fetch 的 SSRF 防护、以及日志中对 bytes 的脱敏/禁止输出

## 许可证

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
