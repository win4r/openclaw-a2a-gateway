# [🚀观看我的哔哩哔哩视频](https://space.bilibili.com/3493277319825652)

# 🦞 OpenClaw A2A Gateway 外掛

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

一個正式可用的 [OpenClaw](https://github.com/openclaw/openclaw) 外掛，實作了 [A2A (Agent-to-Agent) v0.3.0 協定](https://github.com/google/A2A)，讓 OpenClaw 代理能夠跨伺服器進行探索與通訊——零設定安裝，自動對等節點探索。

**目前唯一具備自適應仿生路由、發現和彈性的 A2A Gateway — 為大規模多 Agent 生態而設計。**

## 核心特性

### 傳輸與協定
- **三種傳輸方式**：JSON-RPC、REST 與 gRPC——支援自動降級（依序嘗試 JSON-RPC → REST → gRPC）
- **SSE 串流**搭配心跳保活機制，實現即時任務狀態更新
- **完整 Part 型別支援**：TextPart、FilePart（URI + base64）、DataPart（結構化 JSON）
- **自動 URL 擷取**：代理文字回應中的檔案 URL 會自動提升為對外 FilePart

### 智慧路由
- **規則式路由**：依據訊息模式、標籤或對等節點技能自動選擇目標
- **對等節點技能快取**：健康檢查時擷取 Agent Card 技能，實現基於技能的路由
- **逐訊息 agentId 定向**：將訊息路由至對等節點上的特定 OpenClaw 代理（OpenClaw 擴充功能）

### 探索與韌性
- **DNS-SD 探索**：透過 `_a2a._tcp` SRV + TXT 紀錄自動探索對等節點
- **mDNS 自我廣播**：發布 SRV + TXT 紀錄，讓其他閘道自動找到你
- **健康檢查**搭配指數退避 + 斷路器（closed → open → half-open）
- **推送通知**：任務完成時透過 webhook 推送，支援 HMAC + SSRF 驗證

### 安全性與可觀測性
- **Bearer token 認證**，支援多 token 零停機輪換
- **SSRF 防護**：URI 主機名稱白名單、MIME 白名單、檔案大小限制
- **Ed25519 裝置身份**，相容 OpenClaw ≥2026.3.13 的 scope 機制
- **JSONL 稽核軌跡**，記錄所有 A2A 呼叫與安全事件
- **遙測指標**端點，支援可選的 bearer 認證
- **持久化任務儲存**於磁碟，支援 TTL 清理與併發限制

## 架構

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## 前置需求

- **OpenClaw** ≥ 2026.3.0 已安裝並正在執行
- 伺服器之間的**網路連線**（Tailscale、區域網路或公用 IP）
- **Node.js** ≥ 22

## 安裝

### 快速開始（零設定）

本外掛內建合理的預設值——你可以**無需任何手動設定**即完成安裝與載入：

```bash
# 複製
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# 註冊並啟用
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# 重新啟動
openclaw gateway restart

# 驗證
openclaw plugins list          # 應顯示 a2a-gateway 已載入
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

外掛將以預設的 Agent Card 啟動（`name: "OpenClaw A2A Gateway"`、`skills: [chat]`）。你可以稍後自訂——請參閱下方的[設定 Agent Card](#3-設定-agent-card)。

### 逐步安裝

如果你偏好手動控制或需要保留現有外掛設定：

### 1. 複製外掛

```bash
# 到你的工作區外掛目錄
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. 在 OpenClaw 中註冊外掛

```bash
# 加入允許的外掛清單
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# 告訴 OpenClaw 外掛的位置
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# 啟用外掛
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **注意：** 請將 `<FULL_PATH_TO>` 替換為實際的絕對路徑，例如 `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`。請保留 `plugins.allow` 陣列中的現有外掛。

### 3. 設定 Agent Card

每個 A2A 代理都需要一張描述自身的 Agent Card。如果你跳過此步驟，外掛會使用以下預設值：

| 欄位 | 預設值 |
|------|--------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

自訂設定：

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **重要：** 請將 `<YOUR_IP>` 替換為你的對等節點可連線的 IP 位址（Tailscale IP、區域網路 IP 或公用 IP）。

### 4. 設定 A2A 伺服器

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. 設定安全性（建議）

產生用於入站認證的 token：

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> 請儲存此 token——對等節點需要它來向你的代理進行認證。

### 6. 設定代理路由

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. 重新啟動閘道

```bash
openclaw gateway restart
```

### 8. 驗證

```bash
# 檢查 Agent Card 是否可存取
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

你應該會看到包含名稱、技能和 URL 的 Agent Card。

## 新增對等節點

要與另一個 A2A 代理通訊，需將其新增為對等節點：

```bash
openclaw config set plugins.entries.a2a-gateway.config.peers '[
  {
    "name": "PeerName",
    "agentCardUrl": "http://<PEER_IP>:18800/.well-known/agent-card.json",
    "auth": {
      "type": "bearer",
      "token": "<PEER_TOKEN>"
    }
  }
]'
```

然後重新啟動：

```bash
openclaw gateway restart
```

### 雙向對等（雙向通訊）

要實現雙向通訊，**兩台伺服器**都需要將對方新增為對等節點：

| Server A | Server B |
|----------|----------|
| 對等節點：Server-B（使用 B 的 token） | 對等節點：Server-A（使用 A 的 token） |

每台伺服器各自產生安全 token 並與對方分享。

## 透過 A2A 傳送訊息

### 從命令列

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

此指令碼使用 `@a2a-js/sdk` ClientFactory 自動探索 Agent Card 並選擇最佳傳輸方式。

### 非同步任務模式（適用於長時間執行的提示）

對於長時間提示或多輪討論，避免阻塞單一請求。使用非阻塞模式 + 輪詢：

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --non-blocking \
  --wait \
  --timeout-ms 600000 \
  --poll-ms 1000 \
  --message "Discuss A2A advantages in 3 rounds and provide final conclusion"
```

此指令會傳送 `configuration.blocking=false`，然後輪詢 `tasks/get` 直到任務達到終止狀態。

提示：指令碼的預設 `--timeout-ms` 為 10 分鐘；對於非常長的任務可覆寫此值。

### 指定特定 OpenClaw agentId（OpenClaw 擴充功能）

預設情況下，對等節點會將入站 A2A 訊息路由至 `routing.defaultAgentId`（通常為 `main`）。

若要將單一請求路由至對等節點上的特定 OpenClaw `agentId`，請傳遞 `--agent-id`：

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

此功能透過非標準的 `message.agentId` 欄位實作，僅限本外掛理解。在 JSON-RPC/REST 上最為可靠。gRPC 傳輸可能會丟棄未知的 Message 欄位。

### 代理端執行時感知（TOOLS.md）

即使外掛已安裝並設定完成，LLM 代理也不會可靠地「推斷」如何呼叫 A2A 對等節點（對等節點 URL、token、要執行的命令）。若要實現可靠的**對外** A2A 呼叫，你應該在代理的 `TOOLS.md` 中新增 A2A 區段。

將以下內容新增至代理的 `TOOLS.md`，讓它知道如何呼叫對等節點（完整範本請參閱 `skill/references/tools-md-template.md`）：

```markdown
## A2A Gateway (Agent-to-Agent Communication)

You have an A2A Gateway plugin running on port 18800.

### Peers

| Peer | IP | Auth Token |
|------|-----|------------|
| PeerName | <PEER_IP> | <PEER_TOKEN> |

### How to send a message to a peer

Use the exec tool to run:

\```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "YOUR MESSAGE HERE"

# Optional (OpenClaw extension): route to a specific peer agentId
#  --agent-id coder
\```

The script auto-discovers the Agent Card, handles auth, and prints the peer's response text.
```

接著使用者可以這樣說：
- "Send to PeerName: what's your status?"
- "Ask PeerName to run a health check"

## A2A Part 型別

本外掛支援所有三種 A2A Part 型別的入站訊息。由於 OpenClaw Gateway RPC 僅接受純文字，每種 Part 型別會在分派給代理之前序列化為人類可讀的格式。

| Part 型別 | 傳送給代理的格式 | 範例 |
|-----------|-----------------|------|
| `TextPart` | 原始文字 | `Hello world` |
| `FilePart`（URI） | `[Attached: report.pdf (application/pdf) → https://...]` | 基於 URI 的檔案參照 |
| `FilePart`（base64） | `[Attached: photo.png (image/png), inline 45KB]` | 內嵌檔案附帶大小提示 |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | 結構化 JSON 資料（截斷至 2KB） |

對於對外回應，外掛會將代理負載中的結構化 `mediaUrl`/`mediaUrls` 欄位轉換為 A2A 回應中的 `FilePart` 項目。此外，代理文字回應中嵌入的檔案 URL（Markdown 連結如 `[report](https://…/report.pdf)` 以及裸 URL 如 `https://…/data.csv`）在以已知檔案副檔名結尾時，會自動擷取為 `FilePart` 項目。

### a2a_send_file 代理工具

外掛註冊了一個 `a2a_send_file` 工具，代理可用於向對等節點傳送檔案：

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | 是 | 目標對等節點名稱（必須與已設定的對等節點相符） |
| `uri` | 是 | 檔案的公開 URL |
| `name` | 否 | 檔案名稱（例如 `report.pdf`） |
| `mimeType` | 否 | MIME 型別（省略時會依副檔名自動偵測） |
| `text` | 否 | 隨檔案一同傳送的選用文字訊息 |
| `agentId` | 否 | 路由至對等節點上的特定 agentId（OpenClaw 擴充功能） |

代理互動範例：
- 使用者：「把測試報告傳給 AWS-bot」
- 代理呼叫 `a2a_send_file`，帶上 `peer: "AWS-bot"`、`uri: "https://..."`、`name: "report.pdf"`

## 網路設定

### 方案 A：Tailscale（推薦）

[Tailscale](https://tailscale.com/) 可在你的伺服器之間建立安全的網狀網路，無需任何防火牆設定。

```bash
# 在兩台伺服器上安裝
curl -fsSL https://tailscale.com/install.sh | sh

# 認證（兩台使用同一帳號）
sudo tailscale up

# 檢查連線
tailscale status
# 你會看到每台機器的 IP 如 100.x.x.x

# 驗證
ping <OTHER_SERVER_TAILSCALE_IP>
```

在 A2A 設定中使用 `100.x.x.x` Tailscale IP。流量採端對端加密。

### 方案 B：區域網路

如果兩台伺服器在同一區域網路上，直接使用它們的區域網路 IP。請確認連接埠 18800 可存取。

### 方案 C：公用 IP

使用公用 IP 搭配 bearer token 認證。建議新增防火牆規則以限制僅允許已知 IP 存取。

## 完整範例：雙伺服器設定

### Server A 設定

```bash
# 產生 Server A 的 token
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# 設定 A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# 將 Server B 新增為對等節點（使用 B 的 token）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Server B 設定

```bash
# 產生 Server B 的 token
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# 設定 A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# 將 Server A 新增為對等節點（使用 A 的 token）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### 驗證雙向通訊

```bash
# 從 Server A → 測試 Server B 的 Agent Card
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# 從 Server B → 測試 Server A 的 Agent Card
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# 從 A 傳送訊息至 B（使用 SDK 指令碼）
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## 設定參考

### 核心

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | 此代理的顯示名稱 |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | 人類可讀的描述 |
| `agentCard.url` | string | auto | JSON-RPC 端點 URL |
| `agentCard.skills` | array | `[{chat}]` | 此代理提供的技能清單 |
| `server.host` | string | `0.0.0.0` | 繫結位址 |
| `server.port` | number | `18800` | A2A HTTP 連接埠（gRPC 為 port+1） |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | 持久化磁碟任務儲存路徑 |
| `storage.taskTtlHours` | number | `72` | N 小時後自動清理過期任務 |
| `storage.cleanupIntervalMinutes` | number | `60` | 掃描過期任務的頻率 |

### 對等節點

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | 對等代理清單 |
| `peers[].name` | string | *required* | 對等節點顯示名稱 |
| `peers[].agentCardUrl` | string | *required* | 對等節點 Agent Card 的 URL |
| `peers[].auth.type` | string | — | `bearer` 或 `apiKey` |
| `peers[].auth.token` | string | — | 認證 token |

### 安全性

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` 或 `bearer` |
| `security.token` | string | — | 入站認證的單一 token |
| `security.tokens` | array | `[]` | 零停機輪換的多組 token |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | 檔案傳輸允許的 MIME 模式 |
| `security.maxFileSizeBytes` | number | `52428800` | 基於 URI 的檔案最大大小（50MB） |
| `security.maxInlineFileSizeBytes` | number | `10485760` | 內嵌 base64 檔案最大大小（10MB） |
| `security.fileUriAllowlist` | array | `[]` | URI 主機名稱白名單（空白 = 允許所有公開位址） |

### 路由

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | 入站訊息的代理 ID |
| `routing.rules` | array | `[]` | 規則式路由規則（見下方） |
| `routing.rules[].name` | string | *required* | 規則名稱 |
| `routing.rules[].match.pattern` | string | — | 比對訊息文字的正規表示式（不區分大小寫） |
| `routing.rules[].match.tags` | array | — | 訊息包含任一標籤時比對 |
| `routing.rules[].match.skills` | array | — | 目標對等節點擁有任一技能時比對 |
| `routing.rules[].target.peer` | string | *required* | 路由目標的對等節點 |
| `routing.rules[].target.agentId` | string | — | 覆寫對等節點上的 agentId |
| `routing.rules[].priority` | number | `0` | 數值越高越優先檢查 |

### 韌性

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | 啟用定期 Agent Card 探測 |
| `resilience.healthCheck.intervalMs` | number | `30000` | 探測間隔（毫秒） |
| `resilience.healthCheck.timeoutMs` | number | `5000` | 探測逾時（毫秒） |
| `resilience.retry.maxRetries` | number | `3` | 對外呼叫失敗的最大重試次數 |
| `resilience.retry.baseDelayMs` | number | `1000` | 指數退避的基礎延遲 |
| `resilience.retry.maxDelayMs` | number | `10000` | 最大延遲上限 |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | 斷路器開啟前的失敗次數 |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | 半開探測前的冷卻時間 |

### 探索與廣播

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | 啟用 DNS-SD 對等節點探索 |
| `discovery.serviceName` | string | `_a2a._tcp.local` | 查詢的 DNS-SD 服務名稱 |
| `discovery.refreshIntervalMs` | number | `30000` | 重新查詢 DNS 的頻率（毫秒） |
| `discovery.mergeWithStatic` | boolean | `true` | 將探索到的對等節點與靜態設定合併 |
| `advertise.enabled` | boolean | `false` | 啟用 mDNS 自我廣播 |
| `advertise.serviceName` | string | `_a2a._tcp.local` | 廣播的 DNS-SD 服務類型 |
| `advertise.ttl` | number | `120` | 廣播紀錄的 TTL（秒） |

### 可觀測性

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | 輸出 JSON 結構化日誌 |
| `observability.exposeMetricsEndpoint` | boolean | `true` | 透過 HTTP 公開遙測快照 |
| `observability.metricsPath` | string | `/a2a/metrics` | 遙測的 HTTP 路徑 |
| `observability.metricsAuth` | string | `none` | 指標端點使用 `none` 或 `bearer` |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | JSONL 稽核日誌路徑 |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | 等待代理回應的最長時間（毫秒） |
| `limits.maxConcurrentTasks` | number | `4` | 入站代理執行的最大併發數 |
| `limits.maxQueuedTasks` | number | `100` | 拒絕前的最大佇列任務數 |

## 端點

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card 探索*（別名：`/.well-known/agent.json`）* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC 傳輸 |
| `/a2a/rest` | POST | A2A REST 傳輸 |
| `<host>:<port+1>` | gRPC | A2A gRPC 傳輸 |
| `/a2a/metrics` | GET | 遙測快照（選用 bearer 認證） |
| `/a2a/push/register` | POST | 註冊推送通知 webhook |
| `/a2a/push/:taskId` | DELETE | 取消註冊推送通知 |

## 疑難排解

### "Request accepted (no agent dispatch available)"

此訊息表示 A2A 請求已被閘道接受，但底層 OpenClaw 代理分派未完成。

常見原因：

1) 目標 OpenClaw 實例**未設定 AI 供應商**。

```bash
openclaw config get auth.profiles
```

2) **代理分派逾時**（長時間執行的提示 / 多輪討論）。

修正方式：
- 從傳送端使用非同步任務模式：`--non-blocking --wait`
- 增加外掛逾時時間：`plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs`（預設：300000）


### Agent Card 回傳 404

外掛未載入。請檢查：

```bash
# 驗證外掛在允許清單中
openclaw config get plugins.allow

# 驗證載入路徑正確
openclaw config get plugins.load.paths

# 檢查閘道日誌
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### 連接埠 18800 連線被拒

```bash
# 檢查 A2A 伺服器是否正在監聽
ss -tlnp | grep 18800

# 如果沒有，重新啟動閘道
openclaw gateway restart
```

### 對等節點認證失敗

請確認你的對等節點設定中的 token 與目標伺服器上的 `security.token` 完全一致。

## Agent Skill（適用於 OpenClaw / Codex CLI）

本專案在 `skill/` 目錄中包含一個即用型的**技能**，可引導 AI 代理（OpenClaw、Codex CLI、Claude Code 等）逐步完成完整的 A2A 設定流程——包括安裝、設定、對等節點註冊、TOOLS.md 設定與驗證。

### 為何使用技能？

手動設定 A2A 涉及許多步驟，包含特定的欄位名稱、URL 模式和 token 處理。技能將所有這些編碼為可重複的程序，避免常見錯誤，例如：

- 混淆 `agentCard.url`（JSON-RPC 端點）與 `peers[].agentCardUrl`（Agent Card 探索）
- 忘記更新 TOOLS.md（代理將不知道如何呼叫對等節點）
- 在 `plugins.load.paths` 中使用相對路徑（必須使用絕對路徑）
- 遺漏雙向對等節點註冊（雙方都需要彼此的設定）

### 安裝技能

**適用於 OpenClaw：**

```bash
# 複製到你的技能目錄
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# 或建立符號連結
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**適用於 Codex CLI：**

```bash
# 複製到 Codex 技能目錄
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**適用於 Claude Code：**

```bash
# 複製到你的專案或工作區
cp -r <repo>/skill ./skills/a2a-setup
```

### 技能內容

```
skill/
├── SKILL.md                          # 逐步設定指南
├── scripts/
│   └── a2a-send.mjs                  # 基於 SDK 的訊息傳送器（官方 @a2a-js/sdk）
└── references/
    └── tools-md-template.md          # 代理 A2A 感知的 TOOLS.md 範本
```

技能提供兩種讓代理呼叫對等節點的方式：
- **curl**——通用，隨處可用
- **SDK 指令碼**——使用 `@a2a-js/sdk` ClientFactory，支援自動 Agent Card 探索與傳輸方式選擇

### 使用方式

安裝完成後，告訴你的代理：

- "Set up A2A gateway" / "設定 A2A"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

代理會自動遵循技能的程序執行。

## 仿生設計

當多 Agent 生態從 2 個 peer 擴展到 20 甚至 200 個時，標準 A2A Gateway 會遇到可預見的瓶頸：路由選錯 peer、斷路器一刀切斷流量、探索輪詢浪費頻寬、過載像斷崖一樣突然崩潰。本 Gateway 用**細胞信號傳導**的數學模型來解決這些問題——和細胞路由信號、處理受體過載、在密集組織中發現鄰居用的是同一套原理。

| 生物學 | 機制 | A2A 特性 | 參考文獻 |
|--------|------|----------|---------|
| 配體-受體結合 | Hill 方程 sigmoid | **親和力評分路由** — 多維度匹配評分，可配置陡峭度 (n) 和閾值 (Kd) | Hill (1910) *J Physiol* 40 |
| 受體脫敏 | 磷酸化→內化→回收 | **四態斷路器** — 漸進降級（DESENSITIZED）後全斷（OPEN），指數恢復曲線 | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP 降解 | 磷酸二酯酶酶降解 | **信號衰減通知** — 重要性指數衰減；低於閾值自動放棄重試 | Alon (2007)《系統生物學導論》Ch.4 |
| 群體感應 | 自誘導物濃度閾值 | **密度感知探索** — 基於 peer 數量自適應輪詢，滯後防振盪（explore ↔ stable 模式） | Tamsir *et al.* (2011) *Nature* 469:212 |
| 信號通路選擇 | 通路效率 × 傳導速度 | **自適應傳輸** — 按成功率 × 延遲因子評分排序傳輸協定；未測試的協定優先探索 | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| 酶飽和 | Michaelis-Menten 動力學 | **軟併發限制** — 硬佇列上限前的漸進延遲 `baseDelay × load/(Km + load)` | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### 何時啟用

所有仿生特性**可選且向後相容** — 不顯式配置時，Gateway 行為與標準實作完全一致。當部署規模超過預設值時啟用：

| 特性 | 啟用場景 | 配置鍵 |
|------|---------|--------|
| Hill 親和力路由 | 5+ 個 peer 且技能有重疊 | `routing.affinity` |
| 四態斷路器 | peer 有間歇性故障 | `resilience.circuitBreaker.softThreshold` |
| 信號衰減重試 | webhook 端點不穩定 | 預設啟用 |
| 群體感應探索 | 動態 peer 網路 + DNS-SD | `discovery.quorum` |
| 自適應傳輸 | peer 暴露多種傳輸協定 | 自動（從使用中學習） |
| MM 軟併發 | 高吞吐亞秒級操作 | `limits.saturation` |

> Benchmark: `node --import tsx --test tests/benchmark.test.ts`

## 版本歷史

| 版本 | 重點更新 |
|------|----------|
| **v1.2.0** | 對等節點技能路由、mDNS 自我廣播（對稱探索） |
| **v1.1.0** | URL 擷取、傳輸降級、推送通知、規則式路由、DNS-SD 探索 |
| **v1.0.1** | Ed25519 裝置身份、指標認證、CI |
| **v1.0.0** | 正式可用：持久化、多輪對話、檔案傳輸、SSE、健康檢查、多 token、稽核 |
| **v0.1.0** | 初始 A2A v0.3.0 實作 |

詳細資訊請參閱 [CHANGELOG.md](CHANGELOG.md)，下載請至 [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases)。

## 授權條款

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
