# 🦞 Plugin OpenClaw A2A Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Um plugin pronto para produção do [OpenClaw](https://github.com/openclaw/openclaw) que implementa o [protocolo A2A (Agent-to-Agent) v0.3.0](https://github.com/google/A2A), permitindo que agentes OpenClaw descubram e se comuniquem entre si em diferentes servidores — com instalação sem configuração e descoberta automática de pares.

**O único gateway A2A com roteamento, descoberta e resiliência adaptativos bioinspirados — projetado para ecossistemas multiagente em escala.**

## Principais Recursos

### Transporte e Protocolo
- **Três transportes**: JSON-RPC, REST e gRPC — com fallback automático (tenta JSON-RPC → REST → gRPC)
- **Streaming SSE** com heartbeat keep-alive para status de tarefas em tempo real
- **Suporte completo a tipos Part**: TextPart, FilePart (URI + base64), DataPart (JSON estruturado)
- **Extração automática de URL**: URLs de arquivos nas respostas de texto do agente são promovidas a FileParts de saída

### Roteamento Inteligente
- **Roteamento baseado em regras**: seleção automática de par por padrão de mensagem, tags ou habilidades do par
- **Cache de habilidades do par**: habilidades do Agent Card extraídas durante verificações de saúde, permitindo roteamento baseado em habilidades
- **Direcionamento por agentId por mensagem**: roteamento para agentes OpenClaw específicos no par (extensão OpenClaw)

### Descoberta e Resiliência
- **Descoberta DNS-SD**: descoberta automática de pares via registros SRV + TXT `_a2a._tcp`
- **Auto-anúncio mDNS**: publica registros SRV + TXT para que outros gateways encontrem você automaticamente
- **Verificações de saúde** com backoff exponencial + circuit breaker (fechado → aberto → semi-aberto)
- **Notificações push**: entrega via webhook na conclusão de tarefas com validação HMAC + SSRF

### Segurança e Observabilidade
- **Autenticação bearer token** com rotação multi-token sem tempo de inatividade
- **Proteção SSRF**: allowlist de hostnames de URI, allowlist de MIME, limites de tamanho de arquivo
- **Identidade de dispositivo Ed25519** para compatibilidade de escopo com OpenClaw ≥2026.3.13
- **Trilha de auditoria JSONL** para todas as chamadas A2A e eventos de segurança
- **Endpoint de métricas de telemetria** com autenticação bearer opcional
- **Armazenamento durável de tarefas** em disco com limpeza por TTL e limites de concorrência

## Arquitetura

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Pré-requisitos

- **OpenClaw** ≥ 2026.3.0 instalado e em execução
- **Conectividade de rede** entre servidores (Tailscale, LAN ou IP público)
- **Node.js** ≥ 22

## Instalação

### Início Rápido (sem configuração)

O plugin vem com padrões sensatos — você pode instalá-lo e carregá-lo **sem nenhuma configuração manual**:

```bash
# Clonar
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Registrar e habilitar
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Reiniciar
openclaw gateway restart

# Verificar
openclaw plugins list          # deve mostrar a2a-gateway como carregado
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

O plugin iniciará com o Agent Card padrão (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Você pode personalizá-lo depois — veja [Configurar o Agent Card](#3-configurar-o-agent-card) abaixo.

### Instalação Passo a Passo

Se você preferir controle manual ou precisar manter plugins existentes na sua configuração:

### 1. Clonar o plugin

```bash
# No diretório de plugins do seu workspace
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Registrar o plugin no OpenClaw

```bash
# Adicionar à lista de plugins permitidos
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Informar ao OpenClaw onde encontrar o plugin
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Habilitar o plugin
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Nota:** Substitua `<FULL_PATH_TO>` pelo caminho absoluto real, por exemplo, `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Mantenha quaisquer plugins existentes no array `plugins.allow`.

### 3. Configurar o Agent Card

Todo agente A2A precisa de um Agent Card que o descreva. Se você pular esta etapa, o plugin usa os seguintes padrões:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

Para personalizar:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Importante:** Substitua `<YOUR_IP>` pelo endereço IP acessível pelos seus pares (IP Tailscale, IP da LAN ou IP público).

### 4. Configurar o servidor A2A

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Configurar segurança (recomendado)

Gere um token para autenticação de entrada:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Salve este token — os pares precisarão dele para se autenticar com seu agente.

### 6. Configurar roteamento de agentes

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Reiniciar o gateway

```bash
openclaw gateway restart
```

### 8. Verificar

```bash
# Verificar se o Agent Card está acessível
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Você deverá ver seu Agent Card com nome, habilidades e URL.

## Adicionando Pares

Para se comunicar com outro agente A2A, adicione-o como par:

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

Em seguida, reinicie:

```bash
openclaw gateway restart
```

### Pareamento Mútuo (Ambas as Direções)

Para comunicação bidirecional, **ambos os servidores** precisam adicionar um ao outro como pares:

| Server A | Server B |
|----------|----------|
| Par: Server-B (com o token de B) | Par: Server-A (com o token de A) |

Cada servidor gera seu próprio token de segurança e o compartilha com o outro.

## Enviando Mensagens via A2A

### Pela linha de comando

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

O script usa o ClientFactory do `@a2a-js/sdk` para descobrir automaticamente o Agent Card e selecionar o melhor transporte.

### Modo de tarefa assíncrona (recomendado para prompts de longa duração)

Para prompts longos ou discussões com múltiplas rodadas, evite bloquear uma única requisição. Use o modo não-bloqueante + polling:

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

Isso envia `configuration.blocking=false` e depois faz polling em `tasks/get` até que a tarefa alcance um estado terminal.

Dica: o `--timeout-ms` padrão do script é 10 minutos; sobrescreva-o para tarefas muito longas.

### Direcionar para um agentId OpenClaw específico (extensão OpenClaw)

Por padrão, o par roteia mensagens A2A de entrada para `routing.defaultAgentId` (geralmente `main`).

Para rotear uma única requisição para um `agentId` OpenClaw específico no par, passe `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Isso é implementado como um campo `message.agentId` não padronizado, compreendido por este plugin. Funciona de forma mais confiável via JSON-RPC/REST. O transporte gRPC pode descartar campos Message desconhecidos.

### Consciência de execução do agente (TOOLS.md)

Mesmo que o plugin esteja instalado e configurado, um agente LLM não vai "inferir" de forma confiável como chamar pares A2A (URL do par, token, comando a executar). Para chamadas A2A de **saída** confiáveis, você deve adicionar uma seção A2A ao `TOOLS.md` do agente.

Adicione isso ao `TOOLS.md` do seu agente para que ele saiba como chamar pares (veja `skill/references/tools-md-template.md` para o template completo):

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

Então os usuários podem dizer coisas como:
- "Envie para PeerName: qual é o seu status?"
- "Peça ao PeerName para executar uma verificação de saúde"

## Tipos de Part A2A

O plugin suporta todos os três tipos de Part A2A para mensagens de entrada. Como o Gateway RPC do OpenClaw aceita apenas texto puro, cada tipo de Part é serializado em um formato legível por humanos antes de ser encaminhado ao agente.

| Part Type | Format Sent to Agent | Example |
|-----------|---------------------|---------|
| `TextPart` | Texto puro | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | Referência de arquivo baseada em URI |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Arquivo inline com indicação de tamanho |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Dados JSON estruturados (truncado em 2KB) |

Para respostas de saída, o plugin converte campos estruturados `mediaUrl`/`mediaUrls` do payload do agente em entradas `FilePart` na resposta A2A. Além disso, URLs de arquivos incorporadas na resposta de texto do agente (links markdown como `[report](https://…/report.pdf)` e URLs simples como `https://…/data.csv`) são automaticamente extraídas em entradas `FilePart` quando terminam com uma extensão de arquivo reconhecida.

### Ferramenta de Agente a2a_send_file

O plugin registra uma ferramenta `a2a_send_file` que os agentes podem chamar para enviar arquivos aos pares:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Sim | Nome do par de destino (deve corresponder a um par configurado) |
| `uri` | Sim | URL pública do arquivo a ser enviado |
| `name` | Não | Nome do arquivo (ex.: `report.pdf`) |
| `mimeType` | Não | Tipo MIME (detectado automaticamente pela extensão se omitido) |
| `text` | Não | Mensagem de texto opcional junto com o arquivo |
| `agentId` | Não | Rotear para um agentId específico no par (extensão OpenClaw) |

Exemplo de interação do agente:
- Usuário: "Envie o relatório de teste para AWS-bot"
- Agente chama `a2a_send_file` com `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Configuração de Rede

### Opção A: Tailscale (Recomendado)

O [Tailscale](https://tailscale.com/) cria uma rede mesh segura entre seus servidores sem nenhuma configuração de firewall.

```bash
# Instalar em ambos os servidores
curl -fsSL https://tailscale.com/install.sh | sh

# Autenticar (mesma conta em ambos)
sudo tailscale up

# Verificar conectividade
tailscale status
# Você verá IPs como 100.x.x.x para cada máquina

# Verificar
ping <OTHER_SERVER_TAILSCALE_IP>
```

Use os IPs Tailscale `100.x.x.x` na sua configuração A2A. O tráfego é criptografado ponta a ponta.

### Opção B: LAN

Se ambos os servidores estiverem na mesma rede local, use seus IPs de LAN diretamente. Certifique-se de que a porta 18800 esteja acessível.

### Opção C: IP Público

Use IPs públicos com autenticação bearer token. Considere adicionar regras de firewall para restringir o acesso a IPs conhecidos.

## Exemplo Completo: Configuração de Dois Servidores

### Configuração do Servidor A

```bash
# Gerar token do Server A
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# Configurar A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Adicionar Server B como par (usar o token de B)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Configuração do Servidor B

```bash
# Gerar token do Server B
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# Configurar A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Adicionar Server A como par (usar o token de A)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Verificar ambas as direções

```bash
# Do Server A → testar Agent Card do Server B
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Do Server B → testar Agent Card do Server A
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Enviar uma mensagem A → B (usando script SDK)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Referência de Configuração

### Principal

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Nome de exibição deste agente |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Descrição legível por humanos |
| `agentCard.url` | string | auto | URL do endpoint JSON-RPC |
| `agentCard.skills` | array | `[{chat}]` | Lista de habilidades que este agente oferece |
| `server.host` | string | `0.0.0.0` | Endereço de bind |
| `server.port` | number | `18800` | Porta HTTP A2A (gRPC na porta+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Caminho do armazenamento durável de tarefas em disco |
| `storage.taskTtlHours` | number | `72` | Limpeza automática de tarefas expiradas após N horas |
| `storage.cleanupIntervalMinutes` | number | `60` | Frequência de varredura por tarefas expiradas |

### Pares

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Lista de agentes pares |
| `peers[].name` | string | *required* | Nome de exibição do par |
| `peers[].agentCardUrl` | string | *required* | URL do Agent Card do par |
| `peers[].auth.type` | string | — | `bearer` ou `apiKey` |
| `peers[].auth.token` | string | — | Token de autenticação |

### Segurança

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` ou `bearer` |
| `security.token` | string | — | Token único para autenticação de entrada |
| `security.tokens` | array | `[]` | Múltiplos tokens para rotação sem tempo de inatividade |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Padrões MIME permitidos para transferência de arquivos |
| `security.maxFileSizeBytes` | number | `52428800` | Tamanho máximo de arquivo para arquivos baseados em URI (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Tamanho máximo de arquivo inline base64 (10MB) |
| `security.fileUriAllowlist` | array | `[]` | Allowlist de hostnames de URI (vazio = permitir todos os públicos) |

### Roteamento

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | ID do agente para mensagens de entrada |
| `routing.rules` | array | `[]` | Regras de roteamento baseado em regras (veja abaixo) |
| `routing.rules[].name` | string | *required* | Nome da regra |
| `routing.rules[].match.pattern` | string | — | Regex para corresponder ao texto da mensagem (case-insensitive) |
| `routing.rules[].match.tags` | array | — | Corresponder se a mensagem tiver qualquer uma dessas tags |
| `routing.rules[].match.skills` | array | — | Corresponder se o par de destino tiver qualquer uma dessas habilidades |
| `routing.rules[].target.peer` | string | *required* | Par para o qual rotear |
| `routing.rules[].target.agentId` | string | — | Sobrescrever agentId no par |
| `routing.rules[].priority` | number | `0` | Maior = verificado primeiro |

### Resiliência

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Habilitar sondas periódicas de Agent Card |
| `resilience.healthCheck.intervalMs` | number | `30000` | Intervalo da sonda (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Timeout da sonda (ms) |
| `resilience.retry.maxRetries` | number | `3` | Máximo de tentativas para chamadas de saída com falha |
| `resilience.retry.baseDelayMs` | number | `1000` | Atraso base para backoff exponencial |
| `resilience.retry.maxDelayMs` | number | `10000` | Limite máximo de atraso |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Falhas antes do circuito abrir |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Tempo de espera antes da sonda semi-aberta |

### Descoberta e Anúncio

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Habilitar descoberta de pares via DNS-SD |
| `discovery.serviceName` | string | `_a2a._tcp.local` | Nome do serviço DNS-SD para consulta |
| `discovery.refreshIntervalMs` | number | `30000` | Frequência de re-consulta do DNS (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Mesclar pares descobertos com configuração estática |
| `advertise.enabled` | boolean | `false` | Habilitar auto-anúncio mDNS |
| `advertise.serviceName` | string | `_a2a._tcp.local` | Tipo de serviço DNS-SD para anunciar |
| `advertise.ttl` | number | `120` | TTL em segundos para registros anunciados |

### Observabilidade

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Emitir logs estruturados em JSON |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Expor snapshot de telemetria via HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | Caminho HTTP para telemetria |
| `observability.metricsAuth` | string | `none` | `none` ou `bearer` para o endpoint de métricas |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Caminho para o log de auditoria JSONL |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Tempo máximo de espera pela resposta do agente (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Máximo de execuções de agente de entrada ativas |
| `limits.maxQueuedTasks` | number | `100` | Máximo de tarefas na fila antes da rejeição |

## Pontos de acesso

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Descoberta do Agent Card *(alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | Transporte JSON-RPC A2A |
| `/a2a/rest` | POST | Transporte REST A2A |
| `<host>:<port+1>` | gRPC | Transporte gRPC A2A |
| `/a2a/metrics` | GET | Snapshot de telemetria (autenticação bearer opcional) |
| `/a2a/push/register` | POST | Registrar webhook de notificação push |
| `/a2a/push/:taskId` | DELETE | Cancelar registro de notificação push |

## Resolução de Problemas

### "Request accepted (no agent dispatch available)"

Isso significa que a requisição A2A foi aceita pelo gateway, mas o despacho do agente OpenClaw subjacente não foi concluído.

Causas comuns:

1) **Nenhum provedor de IA configurado** na instância OpenClaw de destino.

```bash
openclaw config get auth.profiles
```

2) **Tempo esgotado no despacho do agente** (prompt de longa duração / discussão com múltiplas rodadas).

Opções de correção:
- Use o modo de tarefa assíncrona no remetente: `--non-blocking --wait`
- Aumente o timeout do plugin: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (padrão: 300000)


### Agent Card retorna 404

O plugin não está carregado. Verifique:

```bash
# Verificar se o plugin está na lista de permitidos
openclaw config get plugins.allow

# Verificar se o caminho de carregamento está correto
openclaw config get plugins.load.paths

# Verificar logs do gateway
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Conexão recusada na porta 18800

```bash
# Verificar se o servidor A2A está escutando
ss -tlnp | grep 18800

# Se não estiver, reinicie o gateway
openclaw gateway restart
```

### Falha na autenticação do par

Certifique-se de que o token na configuração do seu par corresponda exatamente ao `security.token` no servidor de destino.

## Skill do Agente (para OpenClaw / Codex CLI)

Este repositório inclui uma **skill** pronta para uso em `skill/` que guia agentes de IA (OpenClaw, Codex CLI, Claude Code, etc.) pelo processo completo de configuração A2A passo a passo — incluindo instalação, configuração, registro de pares, configuração do TOOLS.md e verificação.

### Por que usar a skill?

Configurar o A2A manualmente envolve muitos passos com nomes de campos específicos, padrões de URL e manipulação de tokens. A skill codifica tudo isso como um procedimento repetível, prevenindo erros comuns como:

- Confundir `agentCard.url` (endpoint JSON-RPC) com `peers[].agentCardUrl` (descoberta do Agent Card)
- Esquecer de atualizar o TOOLS.md (o agente não saberá como chamar pares)
- Usar caminhos relativos em `plugins.load.paths` (devem ser absolutos)
- Esquecer o registro mútuo de pares (ambos os lados precisam da configuração do outro)

### Instalar a skill

**Para OpenClaw:**

```bash
# Copiar para o diretório de skills
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Ou criar link simbólico
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Para Codex CLI:**

```bash
# Copiar para o diretório de skills do Codex
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Para Claude Code:**

```bash
# Copiar para o seu projeto ou workspace
cp -r <repo>/skill ./skills/a2a-setup
```

### O que contém a skill

```
skill/
├── SKILL.md                          # Guia de configuração passo a passo
├── scripts/
│   └── a2a-send.mjs                  # Enviador de mensagens baseado em SDK (oficial @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # Template TOOLS.md para consciência A2A do agente
```

A skill fornece dois métodos para agentes chamarem pares:
- **curl** — universal, funciona em qualquer lugar
- **Script SDK** — usa o ClientFactory do `@a2a-js/sdk` com descoberta automática do Agent Card e seleção de transporte

### Uso

Uma vez instalada, diga ao seu agente:

- "Configurar o gateway A2A" / "Set up A2A gateway"
- "Conectar este OpenClaw a outro servidor via A2A"
- "Adicionar um par A2A"

O agente seguirá o procedimento da skill automaticamente.

## Design Bioinspirado

Quando ecossistemas multiagente escalam de 2 pares para 20 ou 200, gateways A2A padrão encontram barreiras previsíveis: o roteamento escolhe o par errado, circuit breakers cortam o tráfego inteiramente, polling de descoberta desperdiça largura de banda, e a sobrecarga atinge como uma parede. Este gateway resolve esses problemas com mecanismos emprestados da **biologia de sinalização celular** — os mesmos princípios que as células usam para rotear sinais, lidar com sobrecarga de receptores e descobrir vizinhos em tecidos densos.

| Biologia | Mecanismo | Feature A2A | Referência |
|----------|-----------|-------------|------------|
| Ligação ligante-receptor | Sigmoide da equação de Hill | **Roteamento por afinidade** — scoring multidimensional com inclinação (n) e limiar (Kd) configuráveis | Hill (1910) *J Physiol* 40 |
| Dessensibilização de receptores | Fosforilação → internalização → reciclagem | **Circuit breaker de quatro estados** — degradação gradual (DESENSITIZED) antes do bloqueio completo (OPEN), com curva de recuperação exponencial | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| Degradação de cAMP | Decaimento enzimático pela fosfodiesterase | **Notificações com decaimento de sinal** — score de importância decai exponencialmente; retry é abandonado quando abaixo do limiar | Alon (2007) *Intro to Systems Biology* Cap.4 |
| Quorum sensing | Limiar de concentração do autoindutor | **Descoberta com consciência de densidade** — polling adaptativo com histerese (modo exploração ↔ estável) baseado na população de pares | Tamsir *et al.* (2011) *Nature* 469:212 |
| Seleção de via de sinalização | Eficácia da via × velocidade de transdução | **Transporte adaptativo** — scoring por transporte baseado em taxa de sucesso × fator de latência; vias não testadas recebem prioridade de exploração | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Saturação enzimática | Cinética de Michaelis-Menten | **Limitação suave de concorrência** — atraso progressivo `baseDelay × load/(Km + load)` antes do limite rígido da fila | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Quando habilitar

Todas as funcionalidades bioinspiradas são **opcionais e retrocompatíveis** — sem configuração explícita, o gateway se comporta de forma idêntica às implementações padrão. Habilite-as quando sua implantação ultrapassar as configurações padrão:

| Feature | Habilitar quando... | Chave de configuração |
|---------|----------------------|----------------------|
| Roteamento por afinidade de Hill | 5+ pares com habilidades sobrepostas | `routing.affinity` |
| Circuit breaker de quatro estados | Pares têm falhas intermitentes | `resilience.circuitBreaker.softThreshold` |
| Retry com decaimento de sinal | Endpoints de webhook são não confiáveis | Habilitado por padrão |
| Descoberta com quorum sensing | Redes de pares dinâmicas com DNS-SD | `discovery.quorum` |
| Transporte adaptativo | Pares expõem múltiplos transportes | Automático (aprende com o uso) |
| Concorrência suave MM | Operações de alto throughput abaixo de um segundo | `limits.saturation` |

> Benchmark: `npm run benchmark`

## Histórico de Versões

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | Roteamento por habilidades do par, auto-anúncio mDNS (descoberta simétrica) |
| **v1.1.0** | Extração de URL, fallback de transporte, notificações push, roteamento baseado em regras, descoberta DNS-SD |
| **v1.0.1** | Identidade de dispositivo Ed25519, autenticação de métricas, CI |
| **v1.0.0** | Pronto para produção: persistência, multi-rodada, transferência de arquivos, SSE, verificações de saúde, multi-token, auditoria |
| **v0.1.0** | Implementação inicial do A2A v0.3.0 |

Veja [CHANGELOG.md](CHANGELOG.md) para detalhes completos e [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) para downloads.

## Licença

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
