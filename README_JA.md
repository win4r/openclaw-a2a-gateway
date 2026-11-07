[Bilibiliプロフィール](https://space.bilibili.com/3493277319825652)

# 🦞 OpenClaw A2A Gateway プラグイン

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

本番環境対応の [OpenClaw](https://github.com/openclaw/openclaw) プラグインで、[A2A (Agent-to-Agent) v0.3.0 プロトコル](https://github.com/google/A2A)を実装しています。OpenClaw エージェント同士がサーバーを超えて発見・通信できるようになります。設定不要のインストールと自動ピア検出に対応しています。

**適応型バイオインスパイアード・ルーティング、ディスカバリー、レジリエンスを備えた唯一の A2A ゲートウェイ — 大規模マルチエージェントエコシステム向けに設計。**

## 主な機能

### トランスポートとプロトコル
- **3つのトランスポート**: JSON-RPC、REST、gRPC — 自動フォールバック付き（JSON-RPC → REST → gRPC の順で試行）
- **SSE ストリーミング**: ハートビートによるキープアライブでリアルタイムのタスクステータスを配信
- **全 Part タイプ対応**: TextPart、FilePart（URI + base64）、DataPart（構造化 JSON）
- **URL 自動抽出**: エージェントのテキストレスポンスに含まれるファイル URL を送信用 FilePart に自動変換

### インテリジェントルーティング
- **ルールベースルーティング**: メッセージパターン、タグ、またはピアスキルに基づいてピアを自動選択
- **ピアスキルキャッシュ**: ヘルスチェック時に Agent Card のスキルを取得し、スキルベースのルーティングを実現
- **メッセージごとの agentId 指定**: ピア上の特定の OpenClaw エージェントにルーティング（OpenClaw 拡張機能）

### 検出と耐障害性
- **DNS-SD 検出**: `_a2a._tcp` SRV + TXT レコードによるピアの自動検出
- **mDNS 自己広告**: SRV + TXT レコードを公開し、他のゲートウェイが自動的に検出可能
- **ヘルスチェック**: 指数バックオフ + サーキットブレーカー（closed → open → half-open）
- **プッシュ通知**: タスク完了時に HMAC + SSRF バリデーション付きで Webhook 配信

### セキュリティと可観測性
- **Bearer トークン認証**: マルチトークンによるゼロダウンタイムローテーション対応
- **SSRF 防御**: URI ホスト名許可リスト、MIME 許可リスト、ファイルサイズ制限
- **Ed25519 デバイスID**: OpenClaw ≥2026.3.13 のスコープ互換性に対応
- **JSONL 監査ログ**: すべての A2A コールとセキュリティイベントを記録
- **テレメトリメトリクス**: オプションの Bearer 認証付きエンドポイント
- **永続的タスクストア**: TTL クリーンアップと同時実行数制限付きのディスク上ストア

## アーキテクチャ

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## 前提条件

- **OpenClaw** ≥ 2026.3.0 がインストール済みで稼働中であること
- サーバー間の**ネットワーク接続**（Tailscale、LAN、またはパブリック IP）
- **Node.js** ≥ 22

## インストール

### クイックスタート（設定不要）

本プラグインは適切なデフォルト値が設定されており、**手動設定なしで**インストールしてロードできます：

```bash
# クローン
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# 登録と有効化
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# 再起動
openclaw gateway restart

# 確認
openclaw plugins list          # a2a-gateway がロード済みと表示されるはずです
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

プラグインはデフォルトの Agent Card（`name: "OpenClaw A2A Gateway"`、`skills: [chat]`）で起動します。後からカスタマイズできます — 下記の [Agent Card の設定](#3-agent-card-の設定) をご覧ください。

### ステップバイステップのインストール

手動で制御したい場合や、既存のプラグイン設定を維持する必要がある場合：

### 1. プラグインのクローン

```bash
# ワークスペースのプラグインディレクトリにクローン
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. OpenClaw へのプラグイン登録

```bash
# 許可プラグインリストに追加
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# プラグインの場所を OpenClaw に設定
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# プラグインを有効化
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **注意:** `<FULL_PATH_TO>` を実際の絶対パスに置き換えてください（例: `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`）。`plugins.allow` 配列内の既存プラグインはそのまま残してください。

### 3. Agent Card の設定

すべての A2A エージェントには自身を説明する Agent Card が必要です。このステップを省略した場合、プラグインは以下のデフォルト値を使用します：

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

カスタマイズする場合：

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **重要:** `<YOUR_IP>` をピアからアクセス可能な IP アドレス（Tailscale IP、LAN IP、またはパブリック IP）に置き換えてください。

### 4. A2A サーバーの設定

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. セキュリティの設定（推奨）

インバウンド認証用のトークンを生成します：

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> このトークンを保存してください。ピアがあなたのエージェントに認証する際に必要です。

### 6. エージェントルーティングの設定

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. ゲートウェイの再起動

```bash
openclaw gateway restart
```

### 8. 確認

```bash
# Agent Card にアクセスできることを確認
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

名前、スキル、URL が含まれた Agent Card が表示されるはずです。

## ピアの追加

別の A2A エージェントと通信するには、ピアとして追加します：

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

その後、再起動します：

```bash
openclaw gateway restart
```

### 相互ピアリング（双方向）

双方向通信を行うには、**両方のサーバー**が互いをピアとして追加する必要があります：

| Server A | Server B |
|----------|----------|
| ピア: Server-B（B のトークンを使用） | ピア: Server-A（A のトークンを使用） |

各サーバーは独自のセキュリティトークンを生成し、相手と共有します。

## A2A 経由のメッセージ送信

### コマンドラインから

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

このスクリプトは `@a2a-js/sdk` の ClientFactory を使用して Agent Card を自動検出し、最適なトランスポートを選択します。

### 非同期タスクモード（長時間プロンプトに推奨）

長いプロンプトやマルチラウンドのディスカッションでは、単一リクエストのブロックを避けるため、ノンブロッキングモード + ポーリングを使用します：

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

これは `configuration.blocking=false` を送信し、タスクが終了状態に達するまで `tasks/get` をポーリングします。

ヒント: スクリプトのデフォルト `--timeout-ms` は10分です。非常に長いタスクの場合はオーバーライドしてください。

### 特定の OpenClaw agentId への送信（OpenClaw 拡張機能）

デフォルトでは、ピアはインバウンド A2A メッセージを `routing.defaultAgentId`（通常は `main`）にルーティングします。

単一のリクエストをピア上の特定の OpenClaw `agentId` にルーティングするには、`--agent-id` を指定します：

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

これは本プラグインが認識する非標準の `message.agentId` フィールドとして実装されています。JSON-RPC/REST 経由で最も信頼性が高くなります。gRPC トランスポートでは未知の Message フィールドが失われる場合があります。

### エージェント側のランタイム認識（TOOLS.md）

プラグインがインストール・設定されていても、LLM エージェントは A2A ピアの呼び出し方法（ピア URL、トークン、実行コマンド）を確実に「推論」することはできません。信頼性の高い**アウトバウンド** A2A コールを行うには、エージェントの `TOOLS.md` に A2A セクションを追加する必要があります。

エージェントがピアを呼び出す方法を把握できるよう、`TOOLS.md` に以下を追加してください（完全なテンプレートは `skill/references/tools-md-template.md` を参照）：

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

これにより、ユーザーは以下のように指示できます：
- "Send to PeerName: what's your status?"
- "Ask PeerName to run a health check"

## A2A Part タイプ

本プラグインはインバウンドメッセージのすべての A2A Part タイプをサポートしています。OpenClaw Gateway RPC はプレーンテキストのみを受け付けるため、各 Part タイプはエージェントにディスパッチする前に人間が読める形式にシリアライズされます。

| Part Type | Format Sent to Agent | Example |
|-----------|---------------------|---------|
| `TextPart` | そのままのテキスト | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | URI ベースのファイル参照 |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | サイズヒント付きのインラインファイル |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | 構造化 JSON データ（2KB で切り捨て） |

アウトバウンドレスポンスでは、エージェントペイロードの構造化された `mediaUrl`/`mediaUrls` フィールドを A2A レスポンスの `FilePart` エントリに変換します。さらに、エージェントのテキストレスポンスに埋め込まれたファイル URL（`[report](https://…/report.pdf)` のような Markdown リンクや `https://…/data.csv` のような裸の URL）は、認識されたファイル拡張子で終わる場合に自動的に `FilePart` エントリとして抽出されます。

### a2a_send_file エージェントツール

本プラグインは、エージェントがピアにファイルを送信するための `a2a_send_file` ツールを登録します：

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Yes | 対象ピア名（設定済みのピアと一致する必要があります） |
| `uri` | Yes | 送信するファイルのパブリック URL |
| `name` | No | ファイル名（例: `report.pdf`） |
| `mimeType` | No | MIME タイプ（省略時は拡張子から自動検出） |
| `text` | No | ファイルと一緒に送信するオプションのテキストメッセージ |
| `agentId` | No | ピア上の特定の agentId にルーティング（OpenClaw 拡張機能） |

エージェントとの対話例：
- ユーザー: 「テストレポートを AWS-bot に送って」
- エージェントが `a2a_send_file` を `peer: "AWS-bot"`、`uri: "https://..."`、`name: "report.pdf"` で呼び出し

## ネットワーク設定

### オプション A: Tailscale（推奨）

[Tailscale](https://tailscale.com/) は、ファイアウォール設定なしでサーバー間にセキュアなメッシュネットワークを構築します。

```bash
# 両方のサーバーにインストール
curl -fsSL https://tailscale.com/install.sh | sh

# 認証（両方で同じアカウントを使用）
sudo tailscale up

# 接続を確認
tailscale status
# 各マシンに 100.x.x.x のような IP が表示されます

# 確認
ping <OTHER_SERVER_TAILSCALE_IP>
```

A2A 設定には `100.x.x.x` の Tailscale IP を使用してください。通信はエンドツーエンドで暗号化されます。

### オプション B: LAN

両方のサーバーが同じローカルネットワーク上にある場合は、LAN IP を直接使用します。ポート 18800 がアクセス可能であることを確認してください。

### オプション C: パブリック IP

パブリック IP と Bearer トークン認証を使用します。既知の IP へのアクセスを制限するファイアウォールルールの追加を検討してください。

## 完全な例: 2台サーバーのセットアップ

### サーバー A の設定

```bash
# サーバー A のトークンを生成
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# A2A を設定
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# サーバー B をピアとして追加（B のトークンを使用）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### サーバー B の設定

```bash
# サーバー B のトークンを生成
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# A2A を設定
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# サーバー A をピアとして追加（A のトークンを使用）
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### 双方向の確認

```bash
# サーバー A → サーバー B の Agent Card をテスト
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# サーバー B → サーバー A の Agent Card をテスト
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# A → B にメッセージを送信（SDK スクリプトを使用）
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## 設定リファレンス

### コア

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | このエージェントの表示名 |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | 人間が読める説明 |
| `agentCard.url` | string | auto | JSON-RPC エンドポイント URL |
| `agentCard.skills` | array | `[{chat}]` | このエージェントが提供するスキルのリスト |
| `server.host` | string | `0.0.0.0` | バインドアドレス |
| `server.port` | number | `18800` | A2A HTTP ポート（gRPC は port+1） |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | ディスク上の永続タスクストアのパス |
| `storage.taskTtlHours` | number | `72` | N 時間後に期限切れタスクを自動クリーンアップ |
| `storage.cleanupIntervalMinutes` | number | `60` | 期限切れタスクのスキャン間隔 |

### ピア

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | ピアエージェントのリスト |
| `peers[].name` | string | *required* | ピアの表示名 |
| `peers[].agentCardUrl` | string | *required* | ピアの Agent Card の URL |
| `peers[].auth.type` | string | — | `bearer` または `apiKey` |
| `peers[].auth.token` | string | — | 認証トークン |

### セキュリティ

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` または `bearer` |
| `security.token` | string | — | インバウンド認証用の単一トークン |
| `security.tokens` | array | `[]` | ゼロダウンタイムローテーション用の複数トークン |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | ファイル転送に許可される MIME パターン |
| `security.maxFileSizeBytes` | number | `52428800` | URI ベースファイルの最大サイズ（50MB） |
| `security.maxInlineFileSizeBytes` | number | `10485760` | インライン base64 ファイルの最大サイズ（10MB） |
| `security.fileUriAllowlist` | array | `[]` | URI ホスト名の許可リスト（空 = 全パブリックを許可） |

### ルーティング

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | インバウンドメッセージ用のエージェント ID |
| `routing.rules` | array | `[]` | ルールベースのルーティングルール（下記参照） |
| `routing.rules[].name` | string | *required* | ルール名 |
| `routing.rules[].match.pattern` | string | — | メッセージテキストに一致する正規表現（大文字小文字を区別しない） |
| `routing.rules[].match.tags` | array | — | メッセージにこれらのタグのいずれかがある場合に一致 |
| `routing.rules[].match.skills` | array | — | 対象ピアにこれらのスキルのいずれかがある場合に一致 |
| `routing.rules[].target.peer` | string | *required* | ルーティング先のピア |
| `routing.rules[].target.agentId` | string | — | ピア上の agentId をオーバーライド |
| `routing.rules[].priority` | number | `0` | 数値が大きいほど先にチェック |

### 耐障害性

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | 定期的な Agent Card プローブを有効化 |
| `resilience.healthCheck.intervalMs` | number | `30000` | プローブ間隔（ミリ秒） |
| `resilience.healthCheck.timeoutMs` | number | `5000` | プローブのタイムアウト（ミリ秒） |
| `resilience.retry.maxRetries` | number | `3` | 送信失敗時の最大リトライ回数 |
| `resilience.retry.baseDelayMs` | number | `1000` | 指数バックオフの基本遅延 |
| `resilience.retry.maxDelayMs` | number | `10000` | 最大遅延上限 |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | サーキットが開くまでの失敗回数 |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | half-open プローブまでのクールダウン時間 |

### 検出と広告

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | DNS-SD ピア検出を有効化 |
| `discovery.serviceName` | string | `_a2a._tcp.local` | クエリする DNS-SD サービス名 |
| `discovery.refreshIntervalMs` | number | `30000` | DNS の再クエリ間隔（ミリ秒） |
| `discovery.mergeWithStatic` | boolean | `true` | 検出されたピアを静的設定とマージ |
| `advertise.enabled` | boolean | `false` | mDNS 自己広告を有効化 |
| `advertise.serviceName` | string | `_a2a._tcp.local` | 広告する DNS-SD サービスタイプ |
| `advertise.ttl` | number | `120` | 広告レコードの TTL（秒） |

### 可観測性

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | JSON 構造化ログを出力 |
| `observability.exposeMetricsEndpoint` | boolean | `true` | HTTP でテレメトリスナップショットを公開 |
| `observability.metricsPath` | string | `/a2a/metrics` | テレメトリの HTTP パス |
| `observability.metricsAuth` | string | `none` | メトリクスエンドポイントの `none` または `bearer` |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | JSONL 監査ログのパス |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | エージェントレスポンスの最大待機時間（ミリ秒） |
| `limits.maxConcurrentTasks` | number | `4` | アクティブなインバウンドエージェント実行の最大数 |
| `limits.maxQueuedTasks` | number | `100` | 拒否前のキュー最大タスク数 |

## エンドポイント

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card の検出 *（エイリアス: `/.well-known/agent.json`）* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC トランスポート |
| `/a2a/rest` | POST | A2A REST トランスポート |
| `<host>:<port+1>` | gRPC | A2A gRPC トランスポート |
| `/a2a/metrics` | GET | テレメトリスナップショット（オプションの Bearer 認証） |
| `/a2a/push/register` | POST | プッシュ通知 Webhook の登録 |
| `/a2a/push/:taskId` | DELETE | プッシュ通知の登録解除 |

## トラブルシューティング

### "Request accepted (no agent dispatch available)"

このメッセージは、A2A リクエストがゲートウェイに受け入れられたものの、基盤となる OpenClaw エージェントのディスパッチが完了しなかったことを意味します。

一般的な原因：

1) 対象の OpenClaw インスタンスに **AI プロバイダーが設定されていない**。

```bash
openclaw config get auth.profiles
```

2) **エージェントディスパッチがタイムアウト**した（長時間プロンプト/マルチラウンドディスカッション）。

修正方法：
- 送信側から非同期タスクモードを使用: `--non-blocking --wait`
- プラグインのタイムアウトを延長: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs`（デフォルト: 300000）


### Agent Card が 404 を返す

プラグインがロードされていません。以下を確認してください：

```bash
# プラグインが許可リストに含まれているか確認
openclaw config get plugins.allow

# ロードパスが正しいか確認
openclaw config get plugins.load.paths

# ゲートウェイのログを確認
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### ポート 18800 で接続が拒否される

```bash
# A2A サーバーがリッスンしているか確認
ss -tlnp | grep 18800

# リッスンしていない場合はゲートウェイを再起動
openclaw gateway restart
```

### ピア認証が失敗する

ピア設定のトークンが、対象サーバーの `security.token` と完全に一致していることを確認してください。

## エージェントスキル（OpenClaw / Codex CLI 向け）

本リポジトリには、AI エージェント（OpenClaw、Codex CLI、Claude Code など）に A2A セットアッププロセス全体をステップバイステップでガイドするすぐに使える**スキル**が `skill/` に含まれています。インストール、設定、ピア登録、TOOLS.md のセットアップ、検証まで対応しています。

### スキルを使う理由

A2A の手動設定には、特定のフィールド名、URL パターン、トークン処理を伴う多くのステップがあります。スキルはこれらすべてを再現可能な手順としてエンコードし、以下のような一般的なミスを防ぎます：

- `agentCard.url`（JSON-RPC エンドポイント）と `peers[].agentCardUrl`（Agent Card の検出 URL）の混同
- TOOLS.md の更新忘れ（エージェントがピアの呼び出し方を認識できなくなる）
- `plugins.load.paths` での相対パスの使用（絶対パスが必須）
- 相互ピア登録の漏れ（双方がお互いの設定を必要とする）

### スキルのインストール

**OpenClaw の場合:**

```bash
# スキルディレクトリにコピー
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# またはシンボリックリンクを作成
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Codex CLI の場合:**

```bash
# Codex のスキルディレクトリにコピー
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Claude Code の場合:**

```bash
# プロジェクトまたはワークスペースにコピー
cp -r <repo>/skill ./skills/a2a-setup
```

### スキルの内容

```
skill/
├── SKILL.md                          # ステップバイステップのセットアップガイド
├── scripts/
│   └── a2a-send.mjs                  # SDK ベースのメッセージ送信（公式 @a2a-js/sdk）
└── references/
    └── tools-md-template.md          # エージェント A2A 対応用の TOOLS.md テンプレート
```

スキルはエージェントがピアを呼び出すための2つの方法を提供します：
- **curl** — 汎用的で、どこでも動作します
- **SDK スクリプト** — `@a2a-js/sdk` の ClientFactory を使用し、Agent Card の自動検出とトランスポートの選択を行います

### 使い方

インストール後、エージェントに以下のように指示します：

- "Set up A2A gateway" / "A2A ゲートウェイをセットアップして"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

エージェントがスキルの手順に従って自動的に設定を行います。

## バイオインスパイアード設計

マルチエージェントエコシステムが 2 ピアから 20、さらには 200 へとスケールすると、標準的な A2A ゲートウェイは予測可能な壁にぶつかります：ルーティングが間違ったピアを選び、サーキットブレーカーがトラフィックを完全に遮断し、ディスカバリーポーリングが帯域幅を浪費し、過負荷が崖のように突然発生します。本ゲートウェイは**細胞シグナル伝達生物学**から借用したメカニズムでこれらを解決します——細胞がシグナルをルーティングし、受容体の過負荷を処理し、密な組織内で隣接細胞を発見するのと同じ原理です。

| 生物学 | メカニズム | A2A 機能 | 参考文献 |
|--------|-----------|----------|---------|
| リガンド-受容体結合 | Hill 方程式シグモイド | **アフィニティスコアルーティング** — 設定可能な急峻度 (n) と閾値 (Kd) による多次元マッチスコアリング | Hill (1910) *J Physiol* 40 |
| 受容体脱感作 | リン酸化→内在化→リサイクル | **4状態サーキットブレーカー** — 完全遮断 (OPEN) 前の段階的劣化 (DESENSITIZED)、指数回復曲線付き | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP 分解 | ホスホジエステラーゼ酵素分解 | **シグナル減衰通知** — 重要度スコアが指数的に減衰；閾値以下でリトライ放棄 | Alon (2007) *Intro to Systems Biology* Ch.4 |
| クオラムセンシング | オートインデューサー濃度閾値 | **密度認識ディスカバリー** — ピア数に基づく適応的ポーリングとヒステリシス（explore ↔ stable モード） | Tamsir *et al.* (2011) *Nature* 469:212 |
| シグナル経路選択 | 経路効率 × 伝達速度 | **適応型トランスポート** — 成功率 × レイテンシ係数によるトランスポートごとのスコアリング；未テストの経路は探索優先 | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| 酵素飽和 | Michaelis-Menten 動態 | **ソフト同時実行制限** — ハードキュー壁の前に段階的遅延 `baseDelay × load/(Km + load)` | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### 有効化のタイミング

すべてのバイオインスパイアード機能は**オプションであり後方互換** — 明示的な設定なしでは、ゲートウェイは標準実装と同一の動作をします。デフォルトを超える規模のデプロイメント時に有効化してください：

| 機能 | 有効化タイミング | 設定キー |
|------|----------------|---------|
| Hill アフィニティルーティング | 5 以上のピアでスキルが重複 | `routing.affinity` |
| 4 状態サーキットブレーカー | ピアに断続的な障害がある | `resilience.circuitBreaker.softThreshold` |
| シグナル減衰リトライ | Webhook エンドポイントが不安定 | デフォルトで有効 |
| クオラムセンシングディスカバリー | DNS-SD を使用する動的ピアネットワーク | `discovery.quorum` |
| 適応型トランスポート | ピアが複数のトランスポートを公開 | 自動（使用状況から学習） |
| MM ソフト同時実行 | 高スループットのサブ秒オペレーション | `limits.saturation` |

> Benchmark: `node --import tsx --test tests/benchmark.test.ts`

## バージョン履歴

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | ピアスキルルーティング、mDNS 自己広告（対称的検出） |
| **v1.1.0** | URL 抽出、トランスポートフォールバック、プッシュ通知、ルールベースルーティング、DNS-SD 検出 |
| **v1.0.1** | Ed25519 デバイスID、メトリクス認証、CI |
| **v1.0.0** | 本番対応: 永続化、マルチラウンド、ファイル転送、SSE、ヘルスチェック、マルチトークン、監査 |
| **v0.1.0** | A2A v0.3.0 の初期実装 |

詳細は [CHANGELOG.md](CHANGELOG.md) を、ダウンロードは [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) をご覧ください。

## ライセンス

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
