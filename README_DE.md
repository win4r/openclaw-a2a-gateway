[Bilibili-Profil](https://space.bilibili.com/3493277319825652)

# 🦞 OpenClaw A2A Gateway Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Ein produktionsreifes [OpenClaw](https://github.com/openclaw/openclaw)-Plugin, das das [A2A (Agent-to-Agent) v0.3.0 Protokoll](https://github.com/google/A2A) implementiert und es OpenClaw-Agenten ermöglicht, sich serverübergreifend zu entdecken und miteinander zu kommunizieren — mit konfigurationsfreier Installation und automatischer Peer-Erkennung.

**Das einzige A2A-Gateway mit adaptivem, bioinspiriertem Routing, Discovery und Resilienz — entwickelt für Multi-Agenten-Ökosysteme im großen Maßstab.**

## Hauptmerkmale

### Transport & Protokoll
- **Drei Transportwege**: JSON-RPC, REST und gRPC — mit automatischem Fallback (versucht JSON-RPC → REST → gRPC)
- **SSE-Streaming** mit Heartbeat-Keep-Alive für Echtzeit-Taskstatus
- **Vollständige Part-Typ-Unterstützung**: TextPart, FilePart (URI + base64), DataPart (strukturiertes JSON)
- **Automatische URL-Extraktion**: Datei-URLs in Agenten-Textantworten werden zu ausgehenden FileParts befördert

### Intelligentes Routing
- **Regelbasiertes Routing**: automatische Peer-Auswahl anhand von Nachrichtenmustern, Tags oder Peer-Skills
- **Peer-Skills-Caching**: Agent-Card-Skills werden bei Gesundheitsprüfungen extrahiert und ermöglichen skillbasiertes Routing
- **AgentId-Targeting pro Nachricht**: Weiterleitung an bestimmte OpenClaw-Agenten auf dem Peer (OpenClaw-Erweiterung)

### Erkennung & Ausfallsicherheit
- **DNS-SD-Erkennung**: automatische Peer-Erkennung über `_a2a._tcp` SRV + TXT Records
- **mDNS-Selbstankündigung**: Veröffentlichung von SRV + TXT Records, damit andere Gateways Sie automatisch finden
- **Gesundheitsprüfungen** mit exponentiellem Backoff + Circuit Breaker (geschlossen → offen → halboffen)
- **Push-Benachrichtigungen**: Webhook-Zustellung bei Taskabschluss mit HMAC + SSRF-Validierung

### Sicherheit & Beobachtbarkeit
- **Bearer-Token-Authentifizierung** mit Multi-Token-Rotation ohne Ausfallzeit
- **SSRF-Schutz**: URI-Hostname-Allowlist, MIME-Allowlist, Dateigrößenlimits
- **Ed25519-Geräteidentität** für OpenClaw ≥2026.3.13 Scope-Kompatibilität
- **JSONL-Audit-Trail** für alle A2A-Aufrufe und Sicherheitsereignisse
- **Telemetrie-Metriken**-Endpunkt mit optionaler Bearer-Authentifizierung
- **Dauerhafter Task-Speicher** auf Festplatte mit TTL-Bereinigung und Nebenläufigkeitslimits

## Architektur

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Voraussetzungen

- **OpenClaw** ≥ 2026.3.0 installiert und laufend
- **Netzwerkverbindung** zwischen den Servern (Tailscale, LAN oder öffentliche IP)
- **Node.js** ≥ 22

## Installation

### Schnellstart (ohne Konfiguration)

Das Plugin wird mit sinnvollen Standardwerten ausgeliefert — Sie können es **ohne manuelle Konfiguration** installieren und laden:

```bash
# Klonen
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Registrieren & aktivieren
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Neustart
openclaw gateway restart

# Überprüfen
openclaw plugins list          # sollte a2a-gateway als geladen anzeigen
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Das Plugin startet mit der Standard-Agent-Card (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Sie können sie später anpassen — siehe [Agent Card konfigurieren](#3-agent-card-konfigurieren) unten.

### Schritt-für-Schritt-Installation

Wenn Sie manuelle Kontrolle bevorzugen oder vorhandene Plugins in Ihrer Konfiguration beibehalten möchten:

### 1. Plugin klonen

```bash
# In Ihr Workspace-Plugins-Verzeichnis
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Plugin in OpenClaw registrieren

```bash
# Zur Liste erlaubter Plugins hinzufügen
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# OpenClaw mitteilen, wo das Plugin zu finden ist
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Plugin aktivieren
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Hinweis:** Ersetzen Sie `<FULL_PATH_TO>` durch den tatsächlichen absoluten Pfad, z.B. `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Behalten Sie vorhandene Plugins im `plugins.allow`-Array bei.

### 3. Agent Card konfigurieren

Jeder A2A-Agent benötigt eine Agent Card, die ihn beschreibt. Wenn Sie diesen Schritt überspringen, verwendet das Plugin diese Standardwerte:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

Zum Anpassen:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Wichtig:** Ersetzen Sie `<YOUR_IP>` durch die IP-Adresse, die für Ihre Peers erreichbar ist (Tailscale-IP, LAN-IP oder öffentliche IP).

### 4. A2A-Server konfigurieren

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Sicherheit konfigurieren (empfohlen)

Generieren Sie ein Token für die eingehende Authentifizierung:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Speichern Sie dieses Token — Peers benötigen es zur Authentifizierung bei Ihrem Agenten.

### 6. Agenten-Routing konfigurieren

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Gateway neu starten

```bash
openclaw gateway restart
```

### 8. Überprüfen

```bash
# Prüfen, ob die Agent Card erreichbar ist
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Sie sollten Ihre Agent Card mit Name, Skills und URL sehen.

## Peers hinzufügen

Um mit einem anderen A2A-Agenten zu kommunizieren, fügen Sie ihn als Peer hinzu:

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

Dann neu starten:

```bash
openclaw gateway restart
```

### Gegenseitiges Peering (beide Richtungen)

Für bidirektionale Kommunikation müssen **beide Server** den jeweils anderen als Peer hinzufügen:

| Server A | Server B |
|----------|----------|
| Peer: Server-B (mit B's Token) | Peer: Server-A (mit A's Token) |

Jeder Server generiert sein eigenes Sicherheitstoken und teilt es mit dem anderen.

## Nachrichten über A2A senden

### Von der Kommandozeile

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

Das Skript verwendet `@a2a-js/sdk` ClientFactory zur automatischen Erkennung der Agent Card und Auswahl des besten Transportwegs.

### Asynchroner Task-Modus (empfohlen für lang laufende Prompts)

Für lange Prompts oder mehrrundige Diskussionen sollten Sie das Blockieren eines einzelnen Requests vermeiden. Verwenden Sie den nicht-blockierenden Modus + Polling:

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

Dies sendet `configuration.blocking=false` und fragt dann `tasks/get` ab, bis der Task einen Endzustand erreicht.

Tipp: Das Standard-`--timeout-ms` des Skripts beträgt 10 Minuten; überschreiben Sie es für sehr lange Tasks.

### Einen bestimmten OpenClaw agentId ansprechen (OpenClaw-Erweiterung)

Standardmäßig leitet der Peer eingehende A2A-Nachrichten an `routing.defaultAgentId` weiter (oft `main`).

Um eine einzelne Anfrage an eine bestimmte OpenClaw-`agentId` auf dem Peer zu routen, übergeben Sie `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Dies ist als nicht-standardmäßiges `message.agentId`-Feld implementiert, das von diesem Plugin verstanden wird. Es funktioniert am zuverlässigsten über JSON-RPC/REST. Der gRPC-Transport kann unbekannte Message-Felder verwerfen.

### Agentenseitige Laufzeit-Erkennung (TOOLS.md)

Selbst wenn das Plugin installiert und konfiguriert ist, wird ein LLM-Agent nicht zuverlässig "ableiten", wie A2A-Peers aufgerufen werden (Peer-URL, Token, auszuführender Befehl). Für zuverlässige **ausgehende** A2A-Aufrufe sollten Sie einen A2A-Abschnitt in die `TOOLS.md` des Agenten aufnehmen.

Fügen Sie dies zur `TOOLS.md` Ihres Agenten hinzu, damit er weiß, wie Peers aufgerufen werden (siehe `skill/references/tools-md-template.md` für die vollständige Vorlage):

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

Danach können Benutzer beispielsweise sagen:
- "Sende an PeerName: Was ist dein Status?"
- "Frage PeerName, ob er eine Gesundheitsprüfung durchführen kann"

## A2A-Part-Typen

Das Plugin unterstützt alle drei A2A-Part-Typen für eingehende Nachrichten. Da das OpenClaw Gateway RPC nur Klartext akzeptiert, wird jeder Part-Typ vor der Weiterleitung an den Agenten in ein menschenlesbares Format serialisiert.

| Part-Typ | An den Agenten gesendetes Format | Beispiel |
|-----------|---------------------|---------|
| `TextPart` | Rohtext | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | URI-basierte Dateireferenz |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Inline-Datei mit Größenangabe |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Strukturierte JSON-Daten (auf 2KB gekürzt) |

Für ausgehende Antworten konvertiert das Plugin strukturierte `mediaUrl`/`mediaUrls`-Felder aus der Agenten-Payload in `FilePart`-Einträge in der A2A-Antwort. Zusätzlich werden Datei-URLs, die in der Textantwort des Agenten eingebettet sind (Markdown-Links wie `[report](https://…/report.pdf)` und einfache URLs wie `https://…/data.csv`), automatisch in `FilePart`-Einträge extrahiert, wenn sie mit einer erkannten Dateierweiterung enden.

### a2a_send_file Agenten-Tool

Das Plugin registriert ein `a2a_send_file`-Tool, das Agenten zum Senden von Dateien an Peers verwenden können:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Yes | Name des Ziel-Peers (muss mit einem konfigurierten Peer übereinstimmen) |
| `uri` | Yes | Öffentliche URL der zu sendenden Datei |
| `name` | No | Dateiname (z.B. `report.pdf`) |
| `mimeType` | No | MIME-Typ (wird bei Auslassung automatisch aus der Erweiterung erkannt) |
| `text` | No | Optionale Textnachricht zusammen mit der Datei |
| `agentId` | No | An eine bestimmte agentId auf dem Peer weiterleiten (OpenClaw-Erweiterung) |

Beispiel einer Agenten-Interaktion:
- Benutzer: "Sende den Testbericht an AWS-bot"
- Agent ruft `a2a_send_file` auf mit `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Netzwerk-Einrichtung

### Option A: Tailscale (Empfohlen)

[Tailscale](https://tailscale.com/) erstellt ein sicheres Mesh-Netzwerk zwischen Ihren Servern ohne Firewall-Konfiguration.

```bash
# Auf beiden Servern installieren
curl -fsSL https://tailscale.com/install.sh | sh

# Authentifizieren (gleiches Konto auf beiden)
sudo tailscale up

# Konnektivität prüfen
tailscale status
# Sie sehen IPs wie 100.x.x.x für jede Maschine

# Überprüfen
ping <OTHER_SERVER_TAILSCALE_IP>
```

Verwenden Sie die `100.x.x.x` Tailscale-IPs in Ihrer A2A-Konfiguration. Der Datenverkehr ist Ende-zu-Ende verschlüsselt.

### Option B: LAN

Wenn sich beide Server im gleichen lokalen Netzwerk befinden, verwenden Sie deren LAN-IPs direkt. Stellen Sie sicher, dass Port 18800 erreichbar ist.

### Option C: Öffentliche IP

Verwenden Sie öffentliche IPs mit Bearer-Token-Authentifizierung. Erwägen Sie, Firewall-Regeln hinzuzufügen, um den Zugriff auf bekannte IPs zu beschränken.

## Vollständiges Beispiel: Zwei-Server-Setup

### Server A einrichten

```bash
# Server A's Token generieren
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# A2A konfigurieren
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Server B als Peer hinzufügen (B's Token verwenden)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Server B einrichten

```bash
# Server B's Token generieren
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# A2A konfigurieren
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Server A als Peer hinzufügen (A's Token verwenden)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Beide Richtungen überprüfen

```bash
# Von Server A → Server B's Agent Card testen
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Von Server B → Server A's Agent Card testen
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Eine Nachricht A → B senden (mit SDK-Skript)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Konfigurationsreferenz

### Kern

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Anzeigename für diesen Agenten |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Menschenlesbare Beschreibung |
| `agentCard.url` | string | auto | JSON-RPC-Endpunkt-URL |
| `agentCard.skills` | array | `[{chat}]` | Liste der Skills, die dieser Agent anbietet |
| `server.host` | string | `0.0.0.0` | Bind-Adresse |
| `server.port` | number | `18800` | A2A HTTP-Port (gRPC auf Port+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Pfad zum dauerhaften Task-Speicher auf Festplatte |
| `storage.taskTtlHours` | number | `72` | Automatische Bereinigung abgelaufener Tasks nach N Stunden |
| `storage.cleanupIntervalMinutes` | number | `60` | Wie oft nach abgelaufenen Tasks gesucht wird |

### Peers

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Liste der Peer-Agenten |
| `peers[].name` | string | *required* | Anzeigename des Peers |
| `peers[].agentCardUrl` | string | *required* | URL zur Agent Card des Peers |
| `peers[].auth.type` | string | — | `bearer` oder `apiKey` |
| `peers[].auth.token` | string | — | Authentifizierungstoken |

### Sicherheit

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` oder `bearer` |
| `security.token` | string | — | Einzelnes Token für eingehende Authentifizierung |
| `security.tokens` | array | `[]` | Mehrere Tokens für unterbrechungsfreie Rotation |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Erlaubte MIME-Muster für Dateiübertragung |
| `security.maxFileSizeBytes` | number | `52428800` | Maximale Dateigröße für URI-basierte Dateien (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Maximale Inline-base64-Dateigröße (10MB) |
| `security.fileUriAllowlist` | array | `[]` | URI-Hostname-Allowlist (leer = alle öffentlichen erlaubt) |

### Routing

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | Agenten-ID für eingehende Nachrichten |
| `routing.rules` | array | `[]` | Regelbasierte Routing-Regeln (siehe unten) |
| `routing.rules[].name` | string | *required* | Regelname |
| `routing.rules[].match.pattern` | string | — | Regex zum Abgleich des Nachrichtentexts (Groß-/Kleinschreibung ignorierend) |
| `routing.rules[].match.tags` | array | — | Trifft zu, wenn die Nachricht eines dieser Tags enthält |
| `routing.rules[].match.skills` | array | — | Trifft zu, wenn der Ziel-Peer einen dieser Skills hat |
| `routing.rules[].target.peer` | string | *required* | Peer, an den weitergeleitet wird |
| `routing.rules[].target.agentId` | string | — | AgentId auf dem Peer überschreiben |
| `routing.rules[].priority` | number | `0` | Höher = wird zuerst geprüft |

### Ausfallsicherheit

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Periodische Agent-Card-Prüfungen aktivieren |
| `resilience.healthCheck.intervalMs` | number | `30000` | Prüfintervall (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Prüf-Timeout (ms) |
| `resilience.retry.maxRetries` | number | `3` | Maximale Wiederholungsversuche für fehlgeschlagene ausgehende Aufrufe |
| `resilience.retry.baseDelayMs` | number | `1000` | Basisverzögerung für exponentiellen Backoff |
| `resilience.retry.maxDelayMs` | number | `10000` | Maximale Verzögerungsobergrenze |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Fehleranzahl bis der Circuit öffnet |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Abkühlphase vor halboffenem Prüfversuch |

### Erkennung & Ankündigung

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | DNS-SD-Peer-Erkennung aktivieren |
| `discovery.serviceName` | string | `_a2a._tcp.local` | DNS-SD-Dienstname für Abfragen |
| `discovery.refreshIntervalMs` | number | `30000` | Wie oft DNS erneut abgefragt wird (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Erkannte Peers mit statischer Konfiguration zusammenführen |
| `advertise.enabled` | boolean | `false` | mDNS-Selbstankündigung aktivieren |
| `advertise.serviceName` | string | `_a2a._tcp.local` | DNS-SD-Diensttyp für Ankündigung |
| `advertise.ttl` | number | `120` | TTL in Sekunden für angekündigte Records |

### Beobachtbarkeit

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Strukturierte JSON-Logs ausgeben |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Telemetrie-Snapshot über HTTP bereitstellen |
| `observability.metricsPath` | string | `/a2a/metrics` | HTTP-Pfad für Telemetrie |
| `observability.metricsAuth` | string | `none` | `none` oder `bearer` für Metriken-Endpunkt |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Pfad für JSONL-Audit-Log |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Maximale Wartezeit auf Agentenantwort (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Maximale gleichzeitig aktive eingehende Agentenläufe |
| `limits.maxQueuedTasks` | number | `100` | Maximale Warteschlangenlänge vor Ablehnung |

## Endpunkte

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent-Card-Erkennung *(Alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC-Transport |
| `/a2a/rest` | POST | A2A REST-Transport |
| `<host>:<port+1>` | gRPC | A2A gRPC-Transport |
| `/a2a/metrics` | GET | Telemetrie-Snapshot (optionale Bearer-Authentifizierung) |
| `/a2a/push/register` | POST | Push-Benachrichtigungs-Webhook registrieren |
| `/a2a/push/:taskId` | DELETE | Push-Benachrichtigung abmelden |

## Fehlerbehebung

### "Request accepted (no agent dispatch available)"

Dies bedeutet, dass die A2A-Anfrage vom Gateway akzeptiert wurde, aber die zugrunde liegende OpenClaw-Agenten-Weiterleitung nicht abgeschlossen wurde.

Häufige Ursachen:

1) **Kein KI-Anbieter konfiguriert** auf der Ziel-OpenClaw-Instanz.

```bash
openclaw config get auth.profiles
```

2) **Agenten-Weiterleitung hat Zeitüberschreitung** (lang laufender Prompt / mehrrundige Diskussion).

Lösungsmöglichkeiten:
- Verwenden Sie den asynchronen Task-Modus vom Sender: `--non-blocking --wait`
- Erhöhen Sie das Plugin-Timeout: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (Standard: 300000)


### Agent Card gibt 404 zurück

Das Plugin ist nicht geladen. Überprüfen Sie:

```bash
# Überprüfen, ob das Plugin in der Erlaubnisliste ist
openclaw config get plugins.allow

# Überprüfen, ob der Ladepfad korrekt ist
openclaw config get plugins.load.paths

# Gateway-Logs prüfen
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Verbindung auf Port 18800 abgelehnt

```bash
# Prüfen, ob der A2A-Server lauscht
ss -tlnp | grep 18800

# Falls nicht, Gateway neu starten
openclaw gateway restart
```

### Peer-Authentifizierung fehlgeschlagen

Stellen Sie sicher, dass das Token in Ihrer Peer-Konfiguration exakt mit dem `security.token` auf dem Zielserver übereinstimmt.

## Agenten-Skill (für OpenClaw / Codex CLI)

Dieses Repository enthält einen gebrauchsfertigen **Skill** unter `skill/`, der KI-Agenten (OpenClaw, Codex CLI, Claude Code usw.) Schritt für Schritt durch den vollständigen A2A-Einrichtungsprozess führt — einschließlich Installation, Konfiguration, Peer-Registrierung, TOOLS.md-Einrichtung und Überprüfung.

### Warum den Skill verwenden?

Die manuelle Konfiguration von A2A umfasst viele Schritte mit spezifischen Feldnamen, URL-Mustern und Token-Handling. Der Skill kodiert all dies als wiederholbares Verfahren und verhindert häufige Fehler wie:

- Verwechslung von `agentCard.url` (JSON-RPC-Endpunkt) mit `peers[].agentCardUrl` (Agent-Card-Erkennung)
- Vergessen, die TOOLS.md zu aktualisieren (Agent weiß nicht, wie er Peers aufrufen soll)
- Verwendung relativer Pfade in `plugins.load.paths` (müssen absolut sein)
- Fehlende gegenseitige Peer-Registrierung (beide Seiten benötigen die Konfiguration des anderen)

### Skill installieren

**Für OpenClaw:**

```bash
# In Ihr Skills-Verzeichnis kopieren
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Oder verlinken
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Für Codex CLI:**

```bash
# In das Codex-Skills-Verzeichnis kopieren
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Für Claude Code:**

```bash
# In Ihr Projekt oder Ihren Workspace kopieren
cp -r <repo>/skill ./skills/a2a-setup
```

### Was der Skill enthält

```
skill/
├── SKILL.md                          # Schritt-für-Schritt-Einrichtungsanleitung
├── scripts/
│   └── a2a-send.mjs                  # SDK-basierter Nachrichtensender (offizielles @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # TOOLS.md-Vorlage für agentenseitige A2A-Awareness
```

Der Skill bietet zwei Methoden für Agenten, um Peers aufzurufen:
- **curl** — universell, funktioniert überall
- **SDK-Skript** — verwendet `@a2a-js/sdk` ClientFactory mit automatischer Agent-Card-Erkennung und Transportauswahl

### Verwendung

Sobald installiert, sagen Sie Ihrem Agenten:

- "Set up A2A gateway" / "A2A-Gateway einrichten"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

Der Agent folgt dem Verfahren des Skills automatisch.

## Bioinspiriertes Design

Wenn Multi-Agenten-Ökosysteme von 2 Peers auf 20 oder 200 skalieren, stoßen Standard-A2A-Gateways an vorhersehbare Grenzen: Das Routing wählt den falschen Peer, Circuit Breaker unterbrechen den gesamten Verkehr, Discovery-Polling verschwendet Bandbreite, und Überlastung trifft wie eine Wand. Dieses Gateway löst diese Probleme mit Mechanismen aus der **Zellsignalbiologie** — denselben Prinzipien, die Zellen nutzen, um Signale zu leiten, Rezeptorüberlastung zu bewältigen und Nachbarn in dichtem Gewebe zu entdecken.

| Biologie | Mechanismus | A2A-Feature | Referenz |
|----------|-------------|-------------|----------|
| Ligand-Rezeptor-Bindung | Hill-Gleichung (Sigmoid) | **Affinitätsbasiertes Routing** — mehrdimensionales Match-Scoring mit konfigurierbarer Steilheit (n) und Schwellenwert (Kd) | Hill (1910) *J Physiol* 40 |
| Rezeptor-Desensibilisierung | Phosphorylierung → Internalisierung → Recycling | **Vierstufiger Circuit Breaker** — graduelle Degradation (DESENSITIZED) vor vollständiger Blockierung (OPEN), mit exponentieller Erholungskurve | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| cAMP-Abbau | Phosphodiesterase-Enzymabbau | **Signalabfall-Benachrichtigungen** — Wichtigkeitsscore verfällt exponentiell; Wiederholungsversuch wird abgebrochen, wenn unter Schwellenwert | Alon (2007) *Intro to Systems Biology* Kap.4 |
| Quorum Sensing | Autoinducer-Konzentrationschwelle | **Dichtebasierte Erkennung** — adaptives Polling mit Hysterese (Erkundungs- ↔ stabiler Modus) basierend auf Peer-Population | Tamsir *et al.* (2011) *Nature* 469:212 |
| Signalweg-Auswahl | Pfadwirksamkeit × Transduktionsgeschwindigkeit | **Adaptiver Transport** — pro-Transport-Scoring nach Erfolgsrate × Latenzfaktor; ungetestete Pfade erhalten Erkundungspriorität | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Enzymsättigung | Michaelis-Menten-Kinetik | **Weiche Nebenläufigkeitsbegrenzung** — progressive Verzögerung `baseDelay × load/(Km + load)` vor der harten Queue-Grenze | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Wann aktivieren

Alle bioinspirierten Features sind **optional und abwärtskompatibel** — ohne explizite Konfiguration verhält sich das Gateway identisch zu Standardimplementierungen. Aktivieren Sie sie, wenn Ihre Bereitstellung über die Standardeinstellungen hinauswächst:

| Feature | Aktivieren wenn... | Konfigurationsschlüssel |
|---------|---------------------|-------------------------|
| Hill-Affinitätsrouting | 5+ Peers mit überlappenden Skills | `routing.affinity` |
| Vierstufiger Circuit Breaker | Peers haben intermittierende Ausfälle | `resilience.circuitBreaker.softThreshold` |
| Signalabfall-Retry | Webhook-Endpunkte sind unzuverlässig | Standardmäßig aktiviert |
| Quorum-Sensing-Erkennung | Dynamische Peer-Netzwerke mit DNS-SD | `discovery.quorum` |
| Adaptiver Transport | Peers bieten mehrere Transportwege | Automatisch (lernt aus Nutzung) |
| MM weiche Nebenläufigkeit | Hochdurchsatz-Operationen unter einer Sekunde | `limits.saturation` |

> Benchmark: `node --import tsx --test tests/benchmark.test.ts`

## Versionshistorie

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | Peer-Skills-Routing, mDNS-Selbstankündigung (symmetrische Erkennung) |
| **v1.1.0** | URL-Extraktion, Transport-Fallback, Push-Benachrichtigungen, regelbasiertes Routing, DNS-SD-Erkennung |
| **v1.0.1** | Ed25519-Geräteidentität, Metriken-Authentifizierung, CI |
| **v1.0.0** | Produktionsreif: Persistenz, Mehrrundenmodus, Dateiübertragung, SSE, Gesundheitsprüfungen, Multi-Token, Audit |
| **v0.1.0** | Erste A2A v0.3.0 Implementierung |

Siehe [CHANGELOG.md](CHANGELOG.md) für vollständige Details und [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) für Downloads.

## Lizenz

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
