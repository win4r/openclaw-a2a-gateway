# 🦞 Plugin OpenClaw A2A Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Un plugin [OpenClaw](https://github.com/openclaw/openclaw) pronto per la produzione che implementa il [protocollo A2A (Agent-to-Agent) v0.3.0](https://github.com/google/A2A), consentendo agli agenti OpenClaw di scoprirsi e comunicare tra loro attraverso diversi server — con installazione a configurazione zero e scoperta automatica dei peer.

**L'unico gateway A2A con routing, discovery e resilienza adattivi bio-ispirati — progettato per ecosistemi multi-agente su larga scala.**

## Funzionalità Principali

### Trasporto e Protocollo
- **Tre trasporti**: JSON-RPC, REST e gRPC — con fallback automatico (prova JSON-RPC → REST → gRPC)
- **Streaming SSE** con heartbeat keep-alive per lo stato dei task in tempo reale
- **Supporto completo dei tipi Part**: TextPart, FilePart (URI + base64), DataPart (JSON strutturato)
- **Estrazione automatica degli URL**: gli URL dei file nelle risposte testuali dell'agente vengono promossi a FilePart in uscita

### Routing Intelligente
- **Routing basato su regole**: selezione automatica del peer in base a pattern del messaggio, tag o competenze del peer
- **Cache delle competenze dei peer**: le competenze dell'Agent Card vengono estratte durante i controlli di salute, abilitando il routing basato sulle competenze
- **Targeting per agentId per messaggio**: instradamento verso agenti OpenClaw specifici sul peer (estensione OpenClaw)

### Scoperta e Resilienza
- **Scoperta DNS-SD**: scoperta automatica dei peer tramite record SRV + TXT `_a2a._tcp`
- **Auto-annuncio mDNS**: pubblicazione di record SRV + TXT affinche altri gateway vi trovino automaticamente
- **Controlli di salute** con backoff esponenziale + circuit breaker (chiuso → aperto → semi-aperto)
- **Notifiche push**: consegna tramite webhook al completamento del task con validazione HMAC + SSRF

### Sicurezza e Osservabilita
- **Autenticazione bearer token** con rotazione multi-token a zero downtime
- **Protezione SSRF**: allowlist per hostname URI, allowlist MIME, limiti sulla dimensione dei file
- **Identita dispositivo Ed25519** per la compatibilita con gli scope di OpenClaw ≥2026.3.13
- **Traccia di audit JSONL** per tutte le chiamate A2A e gli eventi di sicurezza
- **Endpoint metriche di telemetria** con autenticazione bearer opzionale
- **Archivio task durevole** su disco con pulizia TTL e limiti di concorrenza

## Architettura

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Prerequisiti

- **OpenClaw** ≥ 2026.3.0 installato e in esecuzione
- **Connettivita di rete** tra i server (Tailscale, LAN o IP pubblico)
- **Node.js** ≥ 22

## Installazione

### Avvio Rapido (configurazione zero)

Il plugin viene fornito con impostazioni predefinite ragionevoli — puoi installarlo e caricarlo **senza alcuna configurazione manuale**:

```bash
# Clona
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Registra e abilita
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Riavvia
openclaw gateway restart

# Verifica
openclaw plugins list          # dovrebbe mostrare a2a-gateway come caricato
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Il plugin si avviera con l'Agent Card predefinita (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Potrai personalizzarla in seguito — vedi [Configurare l'Agent Card](#3-configurare-lagent-card) qui sotto.

### Installazione Passo per Passo

Se preferisci il controllo manuale o devi mantenere i plugin esistenti nella tua configurazione:

### 1. Clonare il plugin

```bash
# Nella directory dei plugin del tuo workspace
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Registrare il plugin in OpenClaw

```bash
# Aggiungi alla lista dei plugin consentiti
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Indica a OpenClaw dove trovare il plugin
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Abilita il plugin
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Nota:** Sostituisci `<FULL_PATH_TO>` con il percorso assoluto effettivo, ad es. `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Mantieni eventuali plugin esistenti nell'array `plugins.allow`.

### 3. Configurare l'Agent Card

Ogni agente A2A necessita di un Agent Card che lo descriva. Se salti questo passaggio, il plugin utilizza questi valori predefiniti:

| Campo | Predefinito |
|-------|-------------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

Per personalizzare:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Importante:** Sostituisci `<YOUR_IP>` con l'indirizzo IP raggiungibile dai tuoi peer (IP Tailscale, IP LAN o IP pubblico).

### 4. Configurare il server A2A

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Configurare la sicurezza (raccomandato)

Genera un token per l'autenticazione in ingresso:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Salva questo token — i peer ne avranno bisogno per autenticarsi con il tuo agente.

### 6. Configurare il routing dell'agente

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Riavviare il gateway

```bash
openclaw gateway restart
```

### 8. Verificare

```bash
# Controlla che l'Agent Card sia accessibile
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Dovresti vedere il tuo Agent Card con nome, competenze e URL.

## Aggiungere Peer

Per comunicare con un altro agente A2A, aggiungilo come peer:

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

Poi riavvia:

```bash
openclaw gateway restart
```

### Peering Reciproco (Entrambe le Direzioni)

Per la comunicazione bidirezionale, **entrambi i server** devono aggiungere l'altro come peer:

| Server A | Server B |
|----------|----------|
| Peer: Server-B (con il token di B) | Peer: Server-A (con il token di A) |

Ogni server genera il proprio token di sicurezza e lo condivide con l'altro.

## Invio di Messaggi tramite A2A

### Dalla riga di comando

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

Lo script utilizza `@a2a-js/sdk` ClientFactory per scoprire automaticamente l'Agent Card e selezionare il trasporto migliore.

### Modalità task asincrona (raccomandata per prompt di lunga durata)

Per prompt lunghi o discussioni multi-turno, evita di bloccare una singola richiesta. Usa la modalita non bloccante + polling:

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

Questo invia `configuration.blocking=false` e poi interroga `tasks/get` fino a quando il task raggiunge uno stato terminale.

Suggerimento: il `--timeout-ms` predefinito dello script e 10 minuti; sovrascrivilo per task molto lunghi.

### Indirizzare un agentId OpenClaw specifico (estensione OpenClaw)

Per impostazione predefinita, il peer instrada i messaggi A2A in ingresso a `routing.defaultAgentId` (spesso `main`).

Per instradare una singola richiesta verso uno specifico `agentId` OpenClaw sul peer, passa `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Questo e implementato come un campo non standard `message.agentId` compreso da questo plugin. E piu affidabile su JSON-RPC/REST. Il trasporto gRPC potrebbe eliminare campi Message sconosciuti.

### Consapevolezza runtime lato agente (TOOLS.md)

Anche se il plugin e installato e configurato, un agente LLM non inferira in modo affidabile come chiamare i peer A2A (URL del peer, token, comando da eseguire). Per chiamate A2A **in uscita** affidabili, dovresti aggiungere una sezione A2A al `TOOLS.md` dell'agente.

Aggiungi questo al `TOOLS.md` del tuo agente in modo che sappia come chiamare i peer (vedi `skill/references/tools-md-template.md` per il template completo):

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

Poi gli utenti possono dire cose come:
- "Invia a PeerName: qual e il tuo stato?"
- "Chiedi a PeerName di eseguire un controllo di salute"

## Tipi di Part A2A

Il plugin supporta tutti e tre i tipi di Part A2A per i messaggi in ingresso. Poiche l'RPC del Gateway OpenClaw accetta solo testo semplice, ogni tipo di Part viene serializzato in un formato leggibile prima di essere inviato all'agente.

| Part Type | Formato inviato all'agente | Esempio |
|-----------|---------------------------|---------|
| `TextPart` | Testo grezzo | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | Riferimento a file basato su URI |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | File inline con indicazione della dimensione |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Dati JSON strutturati (troncati a 2KB) |

Per le risposte in uscita, il plugin converte i campi strutturati `mediaUrl`/`mediaUrls` dal payload dell'agente in voci `FilePart` nella risposta A2A. Inoltre, gli URL dei file incorporati nella risposta testuale dell'agente (link markdown come `[report](https://…/report.pdf)` e URL nudi come `https://…/data.csv`) vengono automaticamente estratti in voci `FilePart` quando terminano con un'estensione di file riconosciuta.

### Strumento agente a2a_send_file

Il plugin registra uno strumento `a2a_send_file` che gli agenti possono chiamare per inviare file ai peer:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Si | Nome del peer di destinazione (deve corrispondere a un peer configurato) |
| `uri` | Si | URL pubblico del file da inviare |
| `name` | No | Nome del file (ad es. `report.pdf`) |
| `mimeType` | No | Tipo MIME (rilevato automaticamente dall'estensione se omesso) |
| `text` | No | Messaggio di testo opzionale insieme al file |
| `agentId` | No | Instradamento verso un agentId specifico sul peer (estensione OpenClaw) |

Esempio di interazione con l'agente:
- Utente: "Invia il rapporto di test ad AWS-bot"
- L'agente chiama `a2a_send_file` con `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Configurazione della Rete

### Opzione A: Tailscale (Raccomandato)

[Tailscale](https://tailscale.com/) crea una rete mesh sicura tra i tuoi server senza alcuna configurazione del firewall.

```bash
# Installa su entrambi i server
curl -fsSL https://tailscale.com/install.sh | sh

# Autenticati (stesso account su entrambi)
sudo tailscale up

# Verifica la connettivita
tailscale status
# Vedrai IP come 100.x.x.x per ogni macchina

# Verifica
ping <OTHER_SERVER_TAILSCALE_IP>
```

Usa gli IP Tailscale `100.x.x.x` nella tua configurazione A2A. Il traffico e crittografato end-to-end.

### Opzione B: LAN

Se entrambi i server sono sulla stessa rete locale, usa direttamente i loro IP LAN. Assicurati che la porta 18800 sia accessibile.

### Opzione C: IP Pubblico

Usa IP pubblici con autenticazione bearer token. Considera l'aggiunta di regole firewall per limitare l'accesso ai soli IP noti.

## Esempio Completo: Configurazione a Due Server

### Configurazione Server A

```bash
# Genera il token del Server A
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# Configura A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Aggiungi il Server B come peer (usa il token di B)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Configurazione Server B

```bash
# Genera il token del Server B
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# Configura A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Aggiungi il Server A come peer (usa il token di A)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Verificare entrambe le direzioni

```bash
# Da Server A → testa l'Agent Card del Server B
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Da Server B → testa l'Agent Card del Server A
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Invia un messaggio A → B (usando lo script SDK)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Riferimento di Configurazione

### Principale

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Nome visualizzato per questo agente |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Descrizione leggibile |
| `agentCard.url` | string | auto | URL dell'endpoint JSON-RPC |
| `agentCard.skills` | array | `[{chat}]` | Elenco delle competenze offerte da questo agente |
| `server.host` | string | `0.0.0.0` | Indirizzo di binding |
| `server.port` | number | `18800` | Porta HTTP A2A (gRPC su porta+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Percorso dell'archivio task durevole su disco |
| `storage.taskTtlHours` | number | `72` | Pulizia automatica dei task scaduti dopo N ore |
| `storage.cleanupIntervalMinutes` | number | `60` | Frequenza di scansione per i task scaduti |

### Peer

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Elenco degli agenti peer |
| `peers[].name` | string | *required* | Nome visualizzato del peer |
| `peers[].agentCardUrl` | string | *required* | URL dell'Agent Card del peer |
| `peers[].auth.type` | string | — | `bearer` o `apiKey` |
| `peers[].auth.token` | string | — | Token di autenticazione |

### Sicurezza

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` o `bearer` |
| `security.token` | string | — | Token singolo per l'autenticazione in ingresso |
| `security.tokens` | array | `[]` | Token multipli per la rotazione a zero downtime |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Pattern MIME consentiti per il trasferimento file |
| `security.maxFileSizeBytes` | number | `52428800` | Dimensione massima file per file basati su URI (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Dimensione massima file base64 inline (10MB) |
| `security.fileUriAllowlist` | array | `[]` | Allowlist hostname URI (vuota = consenti tutti i pubblici) |

### Routing

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | ID agente per i messaggi in ingresso |
| `routing.rules` | array | `[]` | Regole di routing basate su regole (vedi sotto) |
| `routing.rules[].name` | string | *required* | Nome della regola |
| `routing.rules[].match.pattern` | string | — | Regex per corrispondere al testo del messaggio (case-insensitive) |
| `routing.rules[].match.tags` | array | — | Corrisponde se il messaggio ha uno di questi tag |
| `routing.rules[].match.skills` | array | — | Corrisponde se il peer di destinazione ha una di queste competenze |
| `routing.rules[].target.peer` | string | *required* | Peer verso cui instradare |
| `routing.rules[].target.agentId` | string | — | Sovrascrive l'agentId sul peer |
| `routing.rules[].priority` | number | `0` | Piu alto = controllato per primo |

### Resilienza

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Abilita sonde periodiche dell'Agent Card |
| `resilience.healthCheck.intervalMs` | number | `30000` | Intervallo tra le sonde (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Timeout della sonda (ms) |
| `resilience.retry.maxRetries` | number | `3` | Numero massimo di tentativi per le chiamate in uscita fallite |
| `resilience.retry.baseDelayMs` | number | `1000` | Ritardo base per il backoff esponenziale |
| `resilience.retry.maxDelayMs` | number | `10000` | Limite massimo del ritardo |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Fallimenti prima dell'apertura del circuito |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Tempo di raffreddamento prima della sonda semi-aperta |

### Scoperta e Annuncio

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Abilita la scoperta peer tramite DNS-SD |
| `discovery.serviceName` | string | `_a2a._tcp.local` | Nome del servizio DNS-SD da interrogare |
| `discovery.refreshIntervalMs` | number | `30000` | Frequenza di rinterrogazione DNS (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Unisci i peer scoperti con la configurazione statica |
| `advertise.enabled` | boolean | `false` | Abilita l'auto-annuncio mDNS |
| `advertise.serviceName` | string | `_a2a._tcp.local` | Tipo di servizio DNS-SD da annunciare |
| `advertise.ttl` | number | `120` | TTL in secondi per i record annunciati |

### Osservabilita

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Emetti log strutturati in JSON |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Esponi lo snapshot di telemetria tramite HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | Percorso HTTP per la telemetria |
| `observability.metricsAuth` | string | `none` | `none` o `bearer` per l'endpoint metriche |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Percorso per il log di audit JSONL |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Attesa massima per la risposta dell'agente (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Numero massimo di esecuzioni agente in ingresso attive |
| `limits.maxQueuedTasks` | number | `100` | Numero massimo di task in coda prima del rifiuto |

## Punti di accesso

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Scoperta dell'Agent Card *(alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | Trasporto A2A JSON-RPC |
| `/a2a/rest` | POST | Trasporto A2A REST |
| `<host>:<port+1>` | gRPC | Trasporto A2A gRPC |
| `/a2a/metrics` | GET | Snapshot di telemetria (autenticazione bearer opzionale) |
| `/a2a/push/register` | POST | Registrazione webhook per notifiche push |
| `/a2a/push/:taskId` | DELETE | Annullamento registrazione notifica push |

## Risoluzione dei Problemi

### "Request accepted (no agent dispatch available)"

Questo significa che la richiesta A2A e stata accettata dal gateway, ma l'invio all'agente OpenClaw sottostante non e stato completato.

Cause comuni:

1) **Nessun provider AI configurato** sull'istanza OpenClaw di destinazione.

```bash
openclaw config get auth.profiles
```

2) **Timeout dell'invio all'agente** (prompt di lunga durata / discussione multi-turno).

Opzioni di risoluzione:
- Usa la modalita task asincrona dal mittente: `--non-blocking --wait`
- Aumenta il timeout del plugin: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (predefinito: 300000)


### L'Agent Card restituisce 404

Il plugin non e caricato. Controlla:

```bash
# Verifica che il plugin sia nella lista dei consentiti
openclaw config get plugins.allow

# Verifica che il percorso di caricamento sia corretto
openclaw config get plugins.load.paths

# Controlla i log del gateway
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Connessione rifiutata sulla porta 18800

```bash
# Controlla se il server A2A e in ascolto
ss -tlnp | grep 18800

# Se no, riavvia il gateway
openclaw gateway restart
```

### L'autenticazione del peer fallisce

Assicurati che il token nella tua configurazione peer corrisponda esattamente al `security.token` sul server di destinazione.

## Skill per Agenti (per OpenClaw / Codex CLI)

Questo repository include una **skill** pronta all'uso in `skill/` che guida gli agenti AI (OpenClaw, Codex CLI, Claude Code, ecc.) attraverso l'intero processo di configurazione A2A passo per passo — inclusa l'installazione, la configurazione, la registrazione dei peer, l'impostazione di TOOLS.md e la verifica.

### Perche usare la skill?

La configurazione manuale di A2A comporta molti passaggi con nomi di campo specifici, pattern di URL e gestione dei token. La skill codifica tutto questo come una procedura ripetibile, prevenendo errori comuni come:

- Confondere `agentCard.url` (endpoint JSON-RPC) con `peers[].agentCardUrl` (scoperta dell'Agent Card)
- Dimenticare di aggiornare TOOLS.md (l'agente non sapra come chiamare i peer)
- Usare percorsi relativi in `plugins.load.paths` (devono essere assoluti)
- Dimenticare la registrazione reciproca dei peer (entrambi i lati necessitano della configurazione dell'altro)

### Installare la skill

**Per OpenClaw:**

```bash
# Copia nella directory delle skill
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Oppure crea un symlink
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Per Codex CLI:**

```bash
# Copia nella directory delle skill di Codex
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Per Claude Code:**

```bash
# Copia nel tuo progetto o workspace
cp -r <repo>/skill ./skills/a2a-setup
```

### Contenuto della skill

```
skill/
├── SKILL.md                          # Guida alla configurazione passo per passo
├── scripts/
│   └── a2a-send.mjs                  # Mittente di messaggi basato su SDK (ufficiale @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # Template TOOLS.md per la consapevolezza A2A dell'agente
```

La skill fornisce due metodi per gli agenti per chiamare i peer:
- **curl** — universale, funziona ovunque
- **Script SDK** — usa `@a2a-js/sdk` ClientFactory con scoperta automatica dell'Agent Card e selezione del trasporto

### Utilizzo

Una volta installata, dici al tuo agente:

- "Set up A2A gateway" / "Configura A2A"
- "Connetti questo OpenClaw a un altro server tramite A2A"
- "Aggiungi un peer A2A"

L'agente seguira automaticamente la procedura della skill.

## Design Bio-ispirato

Quando gli ecosistemi multi-agente scalano da 2 peer a 20 o 200, i gateway A2A standard incontrano ostacoli prevedibili: il routing sceglie il peer sbagliato, i circuit breaker interrompono completamente il traffico, il polling di discovery spreca banda, e il sovraccarico colpisce come un muro. Questo gateway risolve questi problemi con meccanismi presi in prestito dalla **biologia della segnalazione cellulare** — gli stessi principi che le cellule usano per instradare segnali, gestire il sovraccarico dei recettori e scoprire i vicini in tessuti densi.

| Biologia | Meccanismo | Feature A2A | Riferimento |
|----------|------------|-------------|-------------|
| Legame ligando-recettore | Equazione di Hill (sigmoide) | **Routing basato sull'affinità** — scoring multi-dimensionale con pendenza (n) e soglia (Kd) configurabili | Hill (1910) *J Physiol* 40 |
| Desensibilizzazione recettoriale | Fosforilazione → internalizzazione → riciclo | **Circuit breaker a quattro stati** — degradazione graduale (DESENSITIZED) prima del blocco completo (OPEN), con curva di recupero esponenziale | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| Degradazione cAMP | Decadimento enzimatico della fosfodiesterasi | **Notifiche con decadimento del segnale** — il punteggio di importanza decade esponenzialmente; il retry viene abbandonato sotto la soglia | Alon (2007) *Intro to Systems Biology* Cap.4 |
| Quorum sensing | Soglia di concentrazione dell'autoinduttore | **Discovery consapevole della densità** — polling adattivo con isteresi (modalità esplorazione ↔ stabile) basato sulla popolazione dei peer | Tamsir *et al.* (2011) *Nature* 469:212 |
| Selezione del pathway di segnale | Efficacia del pathway × velocità di trasduzione | **Trasporto adattivo** — scoring per trasporto basato su tasso di successo × fattore di latenza; i percorsi non testati hanno priorità di esplorazione | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Saturazione enzimatica | Cinetica di Michaelis-Menten | **Limitazione morbida della concorrenza** — ritardo progressivo `baseDelay × load/(Km + load)` prima del limite rigido della coda | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Quando attivare

Tutte le funzionalità bio-ispirate sono **opzionali e retrocompatibili** — senza configurazione esplicita, il gateway si comporta in modo identico alle implementazioni standard. Attivale quando il tuo deployment supera le impostazioni predefinite:

| Feature | Attiva quando... | Chiave di configurazione |
|---------|-------------------|--------------------------|
| Routing per affinità di Hill | 5+ peer con competenze sovrapposte | `routing.affinity` |
| Circuit breaker a quattro stati | I peer hanno guasti intermittenti | `resilience.circuitBreaker.softThreshold` |
| Retry con decadimento del segnale | Gli endpoint webhook sono inaffidabili | Attivo per impostazione predefinita |
| Discovery con quorum sensing | Reti peer dinamiche con DNS-SD | `discovery.quorum` |
| Trasporto adattivo | I peer espongono trasporti multipli | Automatico (apprende dall'uso) |
| Concorrenza morbida MM | Operazioni ad alto throughput sotto il secondo | `limits.saturation` |

> Benchmark: `npm run benchmark`

## Cronologia delle Versioni

| Versione | Novità |
|----------|--------|
| **v1.2.0** | Routing basato sulle competenze dei peer, auto-annuncio mDNS (scoperta simmetrica) |
| **v1.1.0** | Estrazione URL, fallback del trasporto, notifiche push, routing basato su regole, scoperta DNS-SD |
| **v1.0.1** | Identita dispositivo Ed25519, autenticazione metriche, CI |
| **v1.0.0** | Pronto per la produzione: persistenza, multi-turno, trasferimento file, SSE, controlli di salute, multi-token, audit |
| **v0.1.0** | Implementazione iniziale A2A v0.3.0 |

Consulta [CHANGELOG.md](CHANGELOG.md) per tutti i dettagli e [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) per i download.

## Licenza

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
