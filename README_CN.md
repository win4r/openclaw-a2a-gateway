# 🦞 OpenClaw A2A Gateway 插件

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-486%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

[OpenClaw](https://github.com/openclaw/openclaw) 插件，实现 [A2A (Agent-to-Agent) v0.3.0 协议](https://github.com/google/A2A)，让不同服务器上的 OpenClaw Agent 自动发现、安全通信——零配置即可启动。

**目前唯一具备自适应仿生路由、发现和弹性的 A2A Gateway — 为大规模多 Agent 生态而设计。**

## 核心特性

### 传输与协议
- **三种传输方式**：JSON-RPC、REST、gRPC——支持自动降级（JSON-RPC → REST → gRPC）
- **SSE 流式输出** + 心跳 keep-alive，实时任务状态
- **完整 Part 支持**：TextPart、FilePart（URI + base64）、DataPart（结构化 JSON）
- **URL 自动提取**：Agent 文本回复中的文件链接自动转为出站 FilePart

### 智能路由
- **规则路由**：按消息模式、标签或 Peer 技能自动选择目标
- **Hill 方程亲和力评分**：多维度路由评分，skills/tags/pattern/成功率加权，通过 sigmoid 函数 `score = affinity^n / (Kd^n + affinity^n)` 排序（[Hill, 1910](https://en.wikipedia.org/wiki/Hill_equation_(biochemistry))）
- **Peer 技能缓存**：健康检查时从 Agent Card 提取技能，驱动 skills 路由匹配
- **指定 agentId 路由**：单条消息可路由到 Peer 上的特定 OpenClaw Agent

### 发现与韧性
- **DNS-SD 发现**：通过 `_a2a._tcp` SRV + TXT 记录自动发现 Peer
- **mDNS 自广播**：发布 SRV + TXT 记录，让其他 Gateway 自动发现你
- **四态仿生熔断器**：受体脱敏模型（closed → desensitized → open → recovering），指数恢复曲线
- **Push 通知**：信号衰减重要性管理 + 衰减感知重试，webhook 回调 + SSRF 防护

### 安全与可观测
- **Bearer Token 认证**，多 Token 零停机轮换
- **SSRF 防护**：URI 白名单、MIME 白名单、文件大小限制
- **Ed25519 设备身份**，兼容 OpenClaw ≥2026.3.13 scope 验证
- **JSONL 审计日志**，记录所有 A2A 调用和安全事件
- **Telemetry 指标端点**，可选 Bearer 认证
- **磁盘持久化任务存储**，TTL 自动清理 + 并发限制

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
# 从 npm 安装（推荐）
openclaw plugins install openclaw-a2a-gateway
```

或从源码安装：

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

使用公网 IP + Bearer Token 认证。建议用防火墙限制来源 IP。如果使用反向代理，请参考：[NETWORK_CN.md](./docs/NETWORK_CN.md)

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
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | 磁盘持久化任务目录 |
| `peers` | array | `[]` | 对等 Agent 列表 |
| `peers[].name` | string | *必填* | 对等方显示名称 |
| `peers[].agentCardUrl` | string | *必填* | 对等方 Agent Card URL |
| `peers[].auth.type` | string | — | `bearer` 或 `apiKey` |
| `peers[].auth.token` | string | — | 认证 Token |
| `security.inboundAuth` | string | `none` | `none` 或 `bearer` |
| `security.token` | string | — | 入站认证 Token |
| `routing.defaultAgentId` | string | `default` | 入站消息路由到的 Agent ID |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Agent 响应最大等待时间（毫秒） |
| `limits.maxConcurrentTasks` | number | `4` | 同时运行的入站任务上限 |
| `limits.maxQueuedTasks` | number | `100` | 超过后直接拒绝的新入站任务数上限 |
| `observability.structuredLogs` | boolean | `true` | 输出 JSON 结构化日志 |
| `observability.exposeMetricsEndpoint` | boolean | `true` | 通过 HTTP 暴露 telemetry 快照 |
| `observability.metricsPath` | string | `/a2a/metrics` | telemetry 快照 HTTP 路径 |

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/agent-card.json` | GET | Agent Card（发现） |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC（message/send） |
| `/a2a/rest` | POST | A2A REST 传输 |
| `/a2a/metrics` | GET | JSON telemetry 快照（启用时） |

## 开发调试 CLI

插件自带命令行调试工具，位于 `cli/` 目录。

```bash
cd cli && npm install && npm link   # 或直接: npx tsx cli/bin/a2a.ts
```

| 命令 | 用途 |
|------|------|
| `a2a health <peer>` | 检查对等方是否在线（获取 Agent Card） |
| `a2a health --all` | 批量 ping 所有已配置的对等方 |
| `a2a card <url>` | 展示远程 Agent Card |
| `a2a send <peer> "消息"` | 发消息并展示响应 |
| `a2a stream <peer> "消息"` | SSE 实时流式响应 |
| `a2a status <peer> <taskId>` | 查询任务状态（`--wait` 轮询） |
| `a2a discover` | mDNS 扫描局域网内的 A2A agent |
| `a2a trace <peer> "消息"` | 请求全链路瀑布图（解析→Card→发送） |
| `a2a bench <peer>` | 压测 + 延迟分位数（P50/P90/P99） |

所有命令支持 `--json` 输出。Peer 可以是 `~/.openclaw/a2a-peers.json` 中的别名或直接 URL。

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

## 仿生设计

当多 Agent 生态从 2 个 peer 扩展到 20 甚至 200 个时，标准 A2A Gateway 会遇到可预见的瓶颈：路由选错 peer、熔断器一刀切断流量、发现轮询浪费带宽、过载像断崖一样突然崩溃。本 Gateway 用**细胞信号传导**的数学模型来解决这些问题——和细胞路由信号、处理受体过载、在密集组织中发现邻居用的是同一套原理。

| 生物学 | 机制 | A2A 特性 | 参考文献 |
|--------|------|----------|---------|
| 配体-受体结合 | Hill 方程 sigmoid | **亲和力评分路由** — 多维度匹配评分，可配置陡峭度 (n) 和阈值 (Kd) | Hill (1910) *J Physiol* 40 |
| 受体脱敏 | 磷酸化→内化→回收 | **四态熔断器** — 渐进降级（DESENSITIZED）后全断（OPEN），指数恢复曲线 | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP 降解 | 磷酸二酯酶酶降解 | **信号衰减通知** — 重要性指数衰减；低于阈值自动放弃重试 | Alon (2007)《系统生物学导论》Ch.4 |
| 群体感应 | 自诱导物浓度阈值 | **密度感知发现** — 基于 peer 数量自适应轮询，滞后防振荡（explore ↔ stable 模式） | Tamsir *et al.* (2011) *Nature* 469:212 |
| 信号通路选择 | 通路效率 × 传导速度 | **自适应传输** — 按成功率 × 延迟因子评分排序传输协议；未测试的协议优先探索 | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| 酶饱和 | Michaelis-Menten 动力学 | **软并发限制** — 硬队列上限前的渐进延迟 `baseDelay × load/(Km + load)` | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### 何时启用

所有仿生特性**可选且向后兼容** — 不显式配置时，Gateway 行为与标准实现完全一致。当部署规模超过默认值时启用：

| 特性 | 启用场景 | 配置键 |
|------|---------|--------|
| Hill 亲和力路由 | 5+ 个 peer 且技能有重叠 | `routing.affinity` |
| 四态熔断器 | peer 有间歇性故障 | `resilience.circuitBreaker.softThreshold` |
| 信号衰减重试 | webhook 端点不稳定 | 默认启用 |
| 群体感应发现 | 动态 peer 网络 + DNS-SD | `discovery.quorum` |
| 自适应传输 | peer 暴露多种传输协议 | 自动（从使用中学习） |
| MM 软并发 | 高吞吐亚秒级操作 | `limits.saturation` |

> 基准测试：`node --import tsx --test tests/benchmark.test.ts` — 5 维度 before/after 对比。

## 版本历史

| 版本 | 亮点 |
|------|------|
| **v1.2.0** | Peer 技能路由生效，mDNS 自广播（对称发现闭环） |
| **v1.1.0** | URL 提取、传输降级、Push 通知、规则路由、DNS-SD 发现 |
| **v1.0.1** | Ed25519 设备身份、Metrics 鉴权、CI |
| **v1.0.0** | 生产就绪：持久化、多轮对话、文件传输、SSE、健康检查、多 Token、审计 |
| **v0.1.0** | A2A v0.3.0 初始实现 |

详见 [CHANGELOG.md](CHANGELOG.md) 和 [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases)。

## 许可证

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
