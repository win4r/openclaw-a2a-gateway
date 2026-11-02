# 🦞 OpenClaw A2A Gateway 플러그인

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

프로덕션 수준의 [OpenClaw](https://github.com/openclaw/openclaw) 플러그인으로, [A2A (Agent-to-Agent) v0.3.0 프로토콜](https://github.com/google/A2A)을 구현하여 OpenClaw 에이전트들이 서버 간에 서로를 검색하고 통신할 수 있도록 합니다. 설정 없이 설치 가능하며 피어 자동 검색을 지원합니다.

**적응형 바이오 영감 라우팅, 디스커버리, 레질리언스를 갖춘 유일한 A2A 게이트웨이 — 대규모 멀티 에이전트 생태계를 위해 설계되었습니다.**

## 주요 기능

### 전송 및 프로토콜
- **세 가지 전송 방식**: JSON-RPC, REST, gRPC — 자동 폴백 지원 (JSON-RPC → REST → gRPC 순으로 시도)
- **SSE 스트리밍**: 실시간 작업 상태를 위한 하트비트 keep-alive 지원
- **모든 Part 유형 지원**: TextPart, FilePart (URI + base64), DataPart (구조화된 JSON)
- **자동 URL 추출**: 에이전트 텍스트 응답에 포함된 파일 URL이 아웃바운드 FilePart로 자동 변환

### 지능형 라우팅
- **규칙 기반 라우팅**: 메시지 패턴, 태그 또는 피어 스킬에 따라 피어 자동 선택
- **피어 스킬 캐싱**: 헬스 체크 중 Agent Card 스킬을 추출하여 스킬 기반 라우팅 지원
- **메시지별 agentId 타겟팅**: 피어의 특정 OpenClaw 에이전트로 라우팅 (OpenClaw 확장)

### 검색 및 복원력
- **DNS-SD 검색**: `_a2a._tcp` SRV + TXT 레코드를 통한 피어 자동 검색
- **mDNS 자체 광고**: SRV + TXT 레코드를 게시하여 다른 게이트웨이가 자동으로 발견 가능
- **헬스 체크**: 지수 백오프 + 서킷 브레이커 (closed → open → half-open)
- **푸시 알림**: 작업 완료 시 HMAC + SSRF 검증을 포함한 웹훅 전달

### 보안 및 관측성
- **Bearer 토큰 인증**: 멀티 토큰 무중단 교체 지원
- **SSRF 방어**: URI 호스트명 허용 목록, MIME 허용 목록, 파일 크기 제한
- **Ed25519 디바이스 ID**: OpenClaw ≥2026.3.13 스코프 호환성
- **JSONL 감사 추적**: 모든 A2A 호출 및 보안 이벤트 기록
- **텔레메트리 메트릭** 엔드포인트 (선택적 bearer 인증 지원)
- **영구 작업 저장소**: 디스크 기반 TTL 정리 및 동시성 제한

## 아키텍처

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## 사전 요구 사항

- **OpenClaw** ≥ 2026.3.0 설치 및 실행 중
- 서버 간 **네트워크 연결** (Tailscale, LAN 또는 공인 IP)
- **Node.js** ≥ 22

## 설치

### 빠른 시작 (설정 불필요)

이 플러그인은 합리적인 기본값을 제공하며, **수동 설정 없이** 설치 및 로드할 수 있습니다:

```bash
# 복제
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# 등록 및 활성화
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# 재시작
openclaw gateway restart

# 확인
openclaw plugins list          # a2a-gateway가 로드된 것으로 표시되어야 합니다
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

플러그인은 기본 Agent Card (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`)로 시작합니다. 나중에 사용자 정의할 수 있습니다 — 아래의 [Agent Card 설정](#3-agent-card-설정)을 참조하세요.

### 단계별 설치

수동 제어가 필요하거나 기존 설정의 플러그인을 유지해야 하는 경우:

### 1. 플러그인 복제

```bash
# 워크스페이스 플러그인 디렉토리에 복제
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. OpenClaw에 플러그인 등록

```bash
# 허용 플러그인 목록에 추가
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# OpenClaw에 플러그인 경로 지정
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# 플러그인 활성화
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **참고:** `<FULL_PATH_TO>`를 실제 절대 경로로 교체하세요. 예: `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. `plugins.allow` 배열에 기존 플러그인을 유지하세요.

### 3. Agent Card 설정

모든 A2A 에이전트에는 자신을 설명하는 Agent Card가 필요합니다. 이 단계를 건너뛰면 플러그인은 다음 기본값을 사용합니다:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

사용자 정의하려면:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **중요:** `<YOUR_IP>`를 피어에서 접근 가능한 IP 주소 (Tailscale IP, LAN IP 또는 공인 IP)로 교체하세요.

### 4. A2A 서버 설정

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. 보안 설정 (권장)

인바운드 인증을 위한 토큰 생성:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> 이 토큰을 저장하세요 — 피어가 에이전트에 인증할 때 필요합니다.

### 6. 에이전트 라우팅 설정

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. 게이트웨이 재시작

```bash
openclaw gateway restart
```

### 8. 확인

```bash
# Agent Card 접근 가능 여부 확인
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

이름, 스킬, URL이 포함된 Agent Card가 표시되어야 합니다.

## 피어 추가

다른 A2A 에이전트와 통신하려면 피어로 추가하세요:

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

그런 다음 재시작:

```bash
openclaw gateway restart
```

### 상호 피어링 (양방향)

양방향 통신을 위해서는 **양쪽 서버** 모두 서로를 피어로 추가해야 합니다:

| Server A | Server B |
|----------|----------|
| Peer: Server-B (B의 토큰 사용) | Peer: Server-A (A의 토큰 사용) |

각 서버는 자체 보안 토큰을 생성하고 상대방과 공유합니다.

## A2A를 통한 메시지 전송

### 명령줄에서 전송

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

이 스크립트는 `@a2a-js/sdk` ClientFactory를 사용하여 Agent Card를 자동 검색하고 최적의 전송 방식을 선택합니다.

### 비동기 작업 모드 (장시간 프롬프트에 권장)

장시간 프롬프트나 다중 라운드 토론의 경우, 단일 요청을 차단하지 않도록 하세요. 논블로킹 모드 + 폴링을 사용하세요:

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

이 명령은 `configuration.blocking=false`를 전송한 후 작업이 종료 상태에 도달할 때까지 `tasks/get`을 폴링합니다.

팁: 스크립트의 기본 `--timeout-ms`는 10분입니다. 매우 긴 작업의 경우 이 값을 변경하세요.

### 특정 OpenClaw agentId로 전송 (OpenClaw 확장)

기본적으로 피어는 인바운드 A2A 메시지를 `routing.defaultAgentId` (보통 `main`)로 라우팅합니다.

단일 요청을 피어의 특정 OpenClaw `agentId`로 라우팅하려면 `--agent-id`를 전달하세요:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

이는 이 플러그인이 인식하는 비표준 `message.agentId` 필드로 구현됩니다. JSON-RPC/REST에서 가장 안정적으로 동작하며, gRPC 전송에서는 알 수 없는 Message 필드가 무시될 수 있습니다.

### 에이전트 측 런타임 인식 (TOOLS.md)

플러그인이 설치되고 설정되어 있더라도, LLM 에이전트가 A2A 피어를 호출하는 방법 (피어 URL, 토큰, 실행 명령)을 안정적으로 "추론"하지는 않습니다. 신뢰할 수 있는 **아웃바운드** A2A 호출을 위해서는 에이전트의 `TOOLS.md`에 A2A 섹션을 추가해야 합니다.

에이전트가 피어를 호출하는 방법을 알 수 있도록 `TOOLS.md`에 다음을 추가하세요 (전체 템플릿은 `skill/references/tools-md-template.md`를 참조):

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

그러면 사용자가 다음과 같이 말할 수 있습니다:
- "PeerName에게 전송: 상태가 어때?"
- "PeerName에게 헬스 체크를 실행하라고 요청해"

## A2A Part 유형

이 플러그인은 인바운드 메시지에 대해 세 가지 A2A Part 유형을 모두 지원합니다. OpenClaw Gateway RPC는 일반 텍스트만 수신하므로, 각 Part 유형은 에이전트에 디스패치하기 전에 사람이 읽을 수 있는 형식으로 직렬화됩니다.

| Part Type | Format Sent to Agent | Example |
|-----------|---------------------|---------|
| `TextPart` | 원시 텍스트 | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | URI 기반 파일 참조 |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | 크기 힌트가 포함된 인라인 파일 |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | 구조화된 JSON 데이터 (2KB에서 잘림) |

아웃바운드 응답의 경우, 플러그인은 에이전트 페이로드의 구조화된 `mediaUrl`/`mediaUrls` 필드를 A2A 응답의 `FilePart` 항목으로 변환합니다. 또한 에이전트의 텍스트 응답에 포함된 파일 URL (마크다운 링크 `[report](https://…/report.pdf)` 및 베어 URL `https://…/data.csv`)은 인식된 파일 확장자로 끝나는 경우 자동으로 `FilePart` 항목으로 추출됩니다.

### a2a_send_file 에이전트 도구

플러그인은 에이전트가 피어에게 파일을 보낼 수 있는 `a2a_send_file` 도구를 등록합니다:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Yes | 대상 피어 이름 (설정된 피어와 일치해야 함) |
| `uri` | Yes | 전송할 파일의 공개 URL |
| `name` | No | 파일명 (예: `report.pdf`) |
| `mimeType` | No | MIME 유형 (생략 시 확장자에서 자동 감지) |
| `text` | No | 파일과 함께 보낼 선택적 텍스트 메시지 |
| `agentId` | No | 피어의 특정 agentId로 라우팅 (OpenClaw 확장) |

에이전트 상호작용 예시:
- 사용자: "AWS-bot에게 테스트 보고서를 보내줘"
- 에이전트가 `a2a_send_file`을 호출: `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## 네트워크 설정

### 옵션 A: Tailscale (권장)

[Tailscale](https://tailscale.com/)은 방화벽 설정 없이 서버 간에 보안 메시 네트워크를 생성합니다.

```bash
# 양쪽 서버에 설치
curl -fsSL https://tailscale.com/install.sh | sh

# 인증 (양쪽 동일 계정)
sudo tailscale up

# 연결 확인
tailscale status
# 각 머신에 100.x.x.x 같은 IP가 표시됩니다

# 확인
ping <OTHER_SERVER_TAILSCALE_IP>
```

A2A 설정에서 `100.x.x.x` Tailscale IP를 사용하세요. 트래픽은 종단간 암호화됩니다.

### 옵션 B: LAN

양쪽 서버가 동일한 로컬 네트워크에 있는 경우, LAN IP를 직접 사용하세요. 18800 포트가 접근 가능한지 확인하세요.

### 옵션 C: 공인 IP

Bearer 토큰 인증과 함께 공인 IP를 사용하세요. 알려진 IP로의 접근만 허용하는 방화벽 규칙 추가를 고려하세요.

## 전체 예시: 두 서버 설정

### Server A 설정

```bash
# Server A의 토큰 생성
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# A2A 설정
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Server B를 피어로 추가 (B의 토큰 사용)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Server B 설정

```bash
# Server B의 토큰 생성
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# A2A 설정
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Server A를 피어로 추가 (A의 토큰 사용)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### 양방향 확인

```bash
# Server A → Server B의 Agent Card 테스트
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Server B → Server A의 Agent Card 테스트
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# A → B로 메시지 전송 (SDK 스크립트 사용)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## 설정 참조

### 코어

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | 이 에이전트의 표시 이름 |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | 사람이 읽을 수 있는 설명 |
| `agentCard.url` | string | auto | JSON-RPC 엔드포인트 URL |
| `agentCard.skills` | array | `[{chat}]` | 이 에이전트가 제공하는 스킬 목록 |
| `server.host` | string | `0.0.0.0` | 바인드 주소 |
| `server.port` | number | `18800` | A2A HTTP 포트 (gRPC는 port+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | 디스크 기반 영구 작업 저장소 경로 |
| `storage.taskTtlHours` | number | `72` | N시간 후 만료된 작업 자동 정리 |
| `storage.cleanupIntervalMinutes` | number | `60` | 만료된 작업을 검색하는 주기 |

### 피어

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | 피어 에이전트 목록 |
| `peers[].name` | string | *required* | 피어 표시 이름 |
| `peers[].agentCardUrl` | string | *required* | 피어의 Agent Card URL |
| `peers[].auth.type` | string | — | `bearer` 또는 `apiKey` |
| `peers[].auth.token` | string | — | 인증 토큰 |

### 보안

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` 또는 `bearer` |
| `security.token` | string | — | 인바운드 인증용 단일 토큰 |
| `security.tokens` | array | `[]` | 무중단 교체를 위한 다중 토큰 |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | 파일 전송에 허용된 MIME 패턴 |
| `security.maxFileSizeBytes` | number | `52428800` | URI 기반 파일 최대 크기 (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | 인라인 base64 파일 최대 크기 (10MB) |
| `security.fileUriAllowlist` | array | `[]` | URI 호스트명 허용 목록 (비어있으면 모든 공개 허용) |

### 라우팅

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | 인바운드 메시지의 에이전트 ID |
| `routing.rules` | array | `[]` | 규칙 기반 라우팅 규칙 (아래 참조) |
| `routing.rules[].name` | string | *required* | 규칙 이름 |
| `routing.rules[].match.pattern` | string | — | 메시지 텍스트 매칭용 정규식 (대소문자 무시) |
| `routing.rules[].match.tags` | array | — | 메시지에 이 태그가 있으면 매칭 |
| `routing.rules[].match.skills` | array | — | 대상 피어에 이 스킬이 있으면 매칭 |
| `routing.rules[].target.peer` | string | *required* | 라우팅할 피어 |
| `routing.rules[].target.agentId` | string | — | 피어의 agentId 오버라이드 |
| `routing.rules[].priority` | number | `0` | 높을수록 먼저 확인 |

### 복원력

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | 주기적 Agent Card 프로브 활성화 |
| `resilience.healthCheck.intervalMs` | number | `30000` | 프로브 간격 (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | 프로브 타임아웃 (ms) |
| `resilience.retry.maxRetries` | number | `3` | 실패한 아웃바운드 호출의 최대 재시도 횟수 |
| `resilience.retry.baseDelayMs` | number | `1000` | 지수 백오프의 기본 지연 시간 |
| `resilience.retry.maxDelayMs` | number | `10000` | 최대 지연 상한 |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | 서킷이 열리기 전 실패 횟수 |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | half-open 프로브 전 쿨다운 |

### 검색 및 광고

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | DNS-SD 피어 검색 활성화 |
| `discovery.serviceName` | string | `_a2a._tcp.local` | 조회할 DNS-SD 서비스 이름 |
| `discovery.refreshIntervalMs` | number | `30000` | DNS 재조회 주기 (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | 검색된 피어를 정적 설정과 병합 |
| `advertise.enabled` | boolean | `false` | mDNS 자체 광고 활성화 |
| `advertise.serviceName` | string | `_a2a._tcp.local` | 광고할 DNS-SD 서비스 유형 |
| `advertise.ttl` | number | `120` | 광고된 레코드의 TTL (초) |

### 관측성

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | JSON 구조화 로그 출력 |
| `observability.exposeMetricsEndpoint` | boolean | `true` | HTTP를 통한 텔레메트리 스냅샷 노출 |
| `observability.metricsPath` | string | `/a2a/metrics` | 텔레메트리 HTTP 경로 |
| `observability.metricsAuth` | string | `none` | 메트릭 엔드포인트의 `none` 또는 `bearer` |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | JSONL 감사 로그 경로 |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | 에이전트 응답 최대 대기 시간 (ms) |
| `limits.maxConcurrentTasks` | number | `4` | 최대 동시 인바운드 에이전트 실행 수 |
| `limits.maxQueuedTasks` | number | `100` | 거부 전 최대 대기 작업 수 |

## 엔드포인트

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card 검색 *(별칭: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC 전송 |
| `/a2a/rest` | POST | A2A REST 전송 |
| `<host>:<port+1>` | gRPC | A2A gRPC 전송 |
| `/a2a/metrics` | GET | 텔레메트리 스냅샷 (선택적 bearer 인증) |
| `/a2a/push/register` | POST | 푸시 알림 웹훅 등록 |
| `/a2a/push/:taskId` | DELETE | 푸시 알림 등록 해제 |

## 문제 해결

### "Request accepted (no agent dispatch available)"

이 메시지는 A2A 요청이 게이트웨이에 의해 수락되었지만, 기본 OpenClaw 에이전트 디스패치가 완료되지 않았음을 의미합니다.

일반적인 원인:

1) 대상 OpenClaw 인스턴스에 **AI 제공자가 설정되지 않음**.

```bash
openclaw config get auth.profiles
```

2) **에이전트 디스패치 타임아웃** (장시간 프롬프트 / 다중 라운드 토론).

해결 방법:
- 발신 측에서 비동기 작업 모드 사용: `--non-blocking --wait`
- 플러그인 타임아웃 증가: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (기본값: 300000)


### Agent Card가 404 반환

플러그인이 로드되지 않았습니다. 확인하세요:

```bash
# 플러그인이 허용 목록에 있는지 확인
openclaw config get plugins.allow

# 로드 경로가 올바른지 확인
openclaw config get plugins.load.paths

# 게이트웨이 로그 확인
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### 18800 포트 연결 거부

```bash
# A2A 서버가 수신 대기 중인지 확인
ss -tlnp | grep 18800

# 수신 대기 중이 아니면 게이트웨이 재시작
openclaw gateway restart
```

### 피어 인증 실패

피어 설정의 토큰이 대상 서버의 `security.token`과 정확히 일치하는지 확인하세요.

## 에이전트 스킬 (OpenClaw / Codex CLI용)

이 저장소에는 `skill/`에 바로 사용 가능한 **스킬**이 포함되어 있어 AI 에이전트 (OpenClaw, Codex CLI, Claude Code 등)가 설치, 설정, 피어 등록, TOOLS.md 설정, 검증을 포함한 전체 A2A 설정 과정을 단계별로 진행할 수 있도록 안내합니다.

### 스킬을 사용하는 이유

A2A를 수동으로 설정하려면 특정 필드 이름, URL 패턴, 토큰 처리 등 많은 단계가 필요합니다. 이 스킬은 이 모든 것을 반복 가능한 절차로 인코딩하여 다음과 같은 일반적인 실수를 방지합니다:

- `agentCard.url` (JSON-RPC 엔드포인트)과 `peers[].agentCardUrl` (Agent Card 검색)을 혼동
- TOOLS.md 업데이트 누락 (에이전트가 피어 호출 방법을 모름)
- `plugins.load.paths`에 상대 경로 사용 (절대 경로여야 함)
- 상호 피어 등록 누락 (양쪽 모두 상대방의 설정이 필요)

### 스킬 설치

**OpenClaw용:**

```bash
# 스킬 디렉토리에 복사
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# 또는 심볼릭 링크
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Codex CLI용:**

```bash
# Codex 스킬 디렉토리에 복사
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Claude Code용:**

```bash
# 프로젝트 또는 워크스페이스에 복사
cp -r <repo>/skill ./skills/a2a-setup
```

### 스킬 구성

```
skill/
├── SKILL.md                          # 단계별 설정 가이드
├── scripts/
│   └── a2a-send.mjs                  # SDK 기반 메시지 전송기 (공식 @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # 에이전트 A2A 인식을 위한 TOOLS.md 템플릿
```

스킬은 에이전트가 피어를 호출하는 두 가지 방법을 제공합니다:
- **curl** — 범용, 어디서나 작동
- **SDK 스크립트** — `@a2a-js/sdk` ClientFactory를 사용하여 에이전트 카드 자동 검색 및 전송 방식 선택

### 사용법

설치 후 에이전트에게 다음과 같이 말하세요:

- "Set up A2A gateway" / "A2A 게이트웨이 설정"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

에이전트가 스킬의 절차를 자동으로 따릅니다.

## 바이오 영감 설계

멀티 에이전트 생태계가 2개 피어에서 20개, 200개로 확장되면, 표준 A2A 게이트웨이는 예측 가능한 한계에 부딪힙니다: 라우팅이 잘못된 피어를 선택하고, 서킷 브레이커가 트래픽을 완전히 차단하며, 디스커버리 폴링이 대역폭을 낭비하고, 과부하가 절벽처럼 갑자기 발생합니다. 본 게이트웨이는 **세포 신호 전달 생물학**에서 차용한 메커니즘으로 이러한 문제를 해결합니다 — 세포가 신호를 라우팅하고, 수용체 과부하를 처리하며, 밀집된 조직에서 이웃을 발견하는 것과 동일한 원리입니다.

| 생물학 | 메커니즘 | A2A 기능 | 참고 문헌 |
|--------|---------|----------|----------|
| 리간드-수용체 결합 | Hill 방정식 시그모이드 | **친화도 스코어 라우팅** — 설정 가능한 급경사도 (n) 및 임계값 (Kd)을 갖춘 다차원 매치 스코어링 | Hill (1910) *J Physiol* 40 |
| 수용체 탈감작 | 인산화 → 내재화 → 재활용 | **4상태 서킷 브레이커** — 완전 차단 (OPEN) 전 점진적 저하 (DESENSITIZED), 지수 회복 곡선 | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP 분해 | 포스포디에스테라제 효소 분해 | **신호 감쇠 알림** — 중요도 점수가 지수적으로 감소; 임계값 이하에서 재시도 포기 | Alon (2007) *Intro to Systems Biology* Ch.4 |
| 쿼럼 센싱 | 자기유도물질 농도 임계값 | **밀도 인식 디스커버리** — 피어 수에 기반한 적응적 폴링과 히스테리시스 (explore ↔ stable 모드) | Tamsir *et al.* (2011) *Nature* 469:212 |
| 신호 경로 선택 | 경로 효율 × 전달 속도 | **적응형 전송** — 성공률 × 지연 계수별 전송 스코어링; 미테스트 경로 우선 탐색 | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| 효소 포화 | Michaelis-Menten 동역학 | **소프트 동시성 제한** — 하드 큐 벽 앞의 점진적 지연 `baseDelay × load/(Km + load)` | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### 활성화 시점

모든 바이오 영감 기능은 **선택 사항이며 하위 호환** — 명시적 설정 없이 게이트웨이는 표준 구현과 동일하게 동작합니다. 배포 규모가 기본값을 초과할 때 활성화하세요:

| 기능 | 활성화 시점 | 설정 키 |
|------|-----------|---------|
| Hill 친화도 라우팅 | 5개 이상 피어의 스킬이 중복될 때 | `routing.affinity` |
| 4상태 서킷 브레이커 | 피어에 간헐적 장애가 있을 때 | `resilience.circuitBreaker.softThreshold` |
| 신호 감쇠 재시도 | 웹훅 엔드포인트가 불안정할 때 | 기본 활성화 |
| 쿼럼 센싱 디스커버리 | DNS-SD를 사용하는 동적 피어 네트워크 | `discovery.quorum` |
| 적응형 전송 | 피어가 여러 전송 방식을 노출할 때 | 자동 (사용에서 학습) |
| MM 소프트 동시성 | 고처리량 서브초 작업 | `limits.saturation` |

> Benchmark: `npm run benchmark`

## 버전 기록

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | 피어 스킬 라우팅, mDNS 자체 광고 (대칭 검색) |
| **v1.1.0** | URL 추출, 전송 폴백, 푸시 알림, 규칙 기반 라우팅, DNS-SD 검색 |
| **v1.0.1** | Ed25519 디바이스 ID, 메트릭 인증, CI |
| **v1.0.0** | 프로덕션 준비: 영속성, 다중 라운드, 파일 전송, SSE, 헬스 체크, 멀티 토큰, 감사 |
| **v0.1.0** | 초기 A2A v0.3.0 구현 |

전체 세부 사항은 [CHANGELOG.md](CHANGELOG.md)를, 다운로드는 [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases)를 참조하세요.

## 라이선스

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
