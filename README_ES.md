[Perfil de Bilibili](https://space.bilibili.com/3493277319825652)

# 🦞 Plugin OpenClaw A2A Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Un plugin listo para producción de [OpenClaw](https://github.com/openclaw/openclaw) que implementa el [protocolo A2A (Agent-to-Agent) v0.3.0](https://github.com/google/A2A), permitiendo que los agentes de OpenClaw se descubran y comuniquen entre sí a través de servidores, con instalación sin configuración y descubrimiento automático de pares.

**La única pasarela A2A con enrutamiento, descubrimiento y resiliencia adaptativos bioinspirados — diseñada para ecosistemas multiagente a gran escala.**

## Funcionalidades Principales

### Transporte y Protocolo
- **Tres transportes**: JSON-RPC, REST y gRPC, con respaldo automático (intenta JSON-RPC → REST → gRPC)
- **Streaming SSE** con heartbeat keep-alive para estado de tareas en tiempo real
- **Soporte completo de tipos Part**: TextPart, FilePart (URI + base64), DataPart (JSON estructurado)
- **Extracción automática de URLs**: las URLs de archivos en las respuestas de texto del agente se promueven a FileParts salientes

### Enrutamiento Inteligente
- **Enrutamiento basado en reglas**: selección automática de par por patrón de mensaje, etiquetas o habilidades del par
- **Caché de habilidades de pares**: las habilidades del Agent Card se extraen durante las verificaciones de salud, habilitando el enrutamiento basado en habilidades
- **Targeting por agentId por mensaje**: enrutar a agentes específicos de OpenClaw en el par (extensión de OpenClaw)

### Descubrimiento y Resiliencia
- **Descubrimiento DNS-SD**: descubrimiento automático de pares mediante registros SRV + TXT de `_a2a._tcp`
- **Auto-publicación mDNS**: publicar registros SRV + TXT para que otros gateways te encuentren automáticamente
- **Verificaciones de salud** con retroceso exponencial + circuit breaker (cerrado → abierto → semi-abierto)
- **Notificaciones push**: entrega por webhook al completar tareas con validación HMAC + SSRF

### Seguridad y Observabilidad
- **Autenticación por token Bearer** con rotación multi-token sin tiempo de inactividad
- **Protección SSRF**: lista de permitidos de hostnames para URI, lista de permitidos de MIME, límites de tamaño de archivo
- **Identidad de dispositivo Ed25519** para compatibilidad de scope con OpenClaw ≥2026.3.13
- **Registro de auditoría JSONL** para todas las llamadas A2A y eventos de seguridad
- **Endpoint de métricas de telemetría** con autenticación bearer opcional
- **Almacén de tareas duradero** en disco con limpieza por TTL y límites de concurrencia

## Arquitectura

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Requisitos Previos

- **OpenClaw** ≥ 2026.3.0 instalado y en ejecución
- **Conectividad de red** entre servidores (Tailscale, LAN o IP pública)
- **Node.js** ≥ 22

## Instalación

### Inicio Rápido (sin configuración)

El plugin viene con valores predeterminados razonables; puedes instalarlo y cargarlo **sin ninguna configuración manual**:

```bash
# Clonar
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Registrar y habilitar
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Reiniciar
openclaw gateway restart

# Verificar
openclaw plugins list          # debería mostrar a2a-gateway como cargado
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

El plugin se iniciará con el Agent Card predeterminado (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Puedes personalizarlo después; consulta [Configurar el Agent Card](#3-configurar-el-agent-card) a continuación.

### Instalación Paso a Paso

Si prefieres control manual o necesitas mantener plugins existentes en tu configuración:

### 1. Clonar el plugin

```bash
# En el directorio de plugins de tu workspace
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Registrar el plugin en OpenClaw

```bash
# Agregar a la lista de plugins permitidos
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Indicar a OpenClaw dónde encontrar el plugin
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Habilitar el plugin
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Nota:** Reemplaza `<FULL_PATH_TO>` con la ruta absoluta real, por ejemplo, `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Mantén los plugins existentes en el array `plugins.allow`.

### 3. Configurar el Agent Card

Cada agente A2A necesita un Agent Card que lo describa. Si omites este paso, el plugin usa estos valores predeterminados:

| Campo | Predeterminado |
|-------|----------------|
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

> **Importante:** Reemplaza `<YOUR_IP>` con la dirección IP accesible por tus pares (IP de Tailscale, IP de LAN o IP pública).

### 4. Configurar el servidor A2A

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Configurar seguridad (recomendado)

Genera un token para la autenticación de solicitudes entrantes:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Guarda este token: los pares lo necesitarán para autenticarse con tu agente.

### 6. Configurar el enrutamiento del agente

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Reiniciar el gateway

```bash
openclaw gateway restart
```

### 8. Verificar

```bash
# Comprobar que el Agent Card es accesible
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Deberías ver tu Agent Card con nombre, habilidades y URL.

## Agregar Pares

Para comunicarte con otro agente A2A, agrégalo como par:

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

Luego reinicia:

```bash
openclaw gateway restart
```

### Emparejamiento Mutuo (Ambas Direcciones)

Para comunicación bidireccional, **ambos servidores** deben agregar al otro como par:

| Servidor A | Servidor B |
|------------|------------|
| Par: Server-B (con el token de B) | Par: Server-A (con el token de A) |

Cada servidor genera su propio token de seguridad y lo comparte con el otro.

## Enviar Mensajes vía A2A

### Desde la línea de comandos

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

El script utiliza `@a2a-js/sdk` ClientFactory para descubrir automáticamente el Agent Card y seleccionar el mejor transporte.

### Modo de tarea asíncrona (recomendado para prompts de larga duración)

Para prompts largos o discusiones de múltiples rondas, evita bloquear una sola solicitud. Usa el modo no bloqueante + sondeo:

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

Esto envía `configuration.blocking=false` y luego sondea `tasks/get` hasta que la tarea alcance un estado terminal.

Consejo: el `--timeout-ms` predeterminado del script es 10 minutos; ajústalo para tareas muy largas.

### Dirigir a un agentId específico de OpenClaw (extensión de OpenClaw)

Por defecto, el par enruta los mensajes A2A entrantes a `routing.defaultAgentId` (generalmente `main`).

Para enrutar una solicitud individual a un `agentId` específico de OpenClaw en el par, pasa `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Esto se implementa como un campo no estándar `message.agentId` entendido por este plugin. Es más confiable sobre JSON-RPC/REST. El transporte gRPC puede descartar campos de Message desconocidos.

### Conocimiento del agente en tiempo de ejecución (TOOLS.md)

Incluso si el plugin está instalado y configurado, un agente LLM no inferirá de manera confiable cómo llamar a los pares A2A (URL del par, token, comando a ejecutar). Para llamadas A2A **salientes** confiables, deberías agregar una sección A2A al `TOOLS.md` del agente.

Agrega esto al `TOOLS.md` de tu agente para que sepa cómo llamar a los pares (consulta `skill/references/tools-md-template.md` para la plantilla completa):

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

Luego los usuarios pueden decir cosas como:
- "Envía a PeerName: ¿cuál es tu estado?"
- "Pide a PeerName que ejecute una verificación de salud"

## Tipos de Part en A2A

El plugin soporta los tres tipos de Part de A2A para mensajes entrantes. Dado que la RPC del Gateway de OpenClaw solo acepta texto plano, cada tipo de Part se serializa en un formato legible antes de enviarlo al agente.

| Tipo de Part | Formato Enviado al Agente | Ejemplo |
|--------------|--------------------------|---------|
| `TextPart` | Texto sin formato | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | Referencia de archivo basada en URI |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Archivo embebido con indicación de tamaño |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Datos JSON estructurados (truncados a 2KB) |

Para las respuestas salientes, el plugin convierte los campos estructurados `mediaUrl`/`mediaUrls` del payload del agente en entradas `FilePart` en la respuesta A2A. Además, las URLs de archivos incrustadas en la respuesta de texto del agente (enlaces markdown como `[report](https://…/report.pdf)` y URLs sueltas como `https://…/data.csv`) se extraen automáticamente en entradas `FilePart` cuando terminan con una extensión de archivo reconocida.

### Herramienta del agente a2a_send_file

El plugin registra una herramienta `a2a_send_file` que los agentes pueden usar para enviar archivos a los pares:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Yes | Nombre del par de destino (debe coincidir con un par configurado) |
| `uri` | Yes | URL pública del archivo a enviar |
| `name` | No | Nombre del archivo (por ejemplo, `report.pdf`) |
| `mimeType` | No | Tipo MIME (se detecta automáticamente a partir de la extensión si se omite) |
| `text` | No | Mensaje de texto opcional junto con el archivo |
| `agentId` | No | Enrutar a un agentId específico en el par (extensión de OpenClaw) |

Ejemplo de interacción del agente:
- Usuario: "Envía el informe de pruebas a AWS-bot"
- El agente llama a `a2a_send_file` con `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Configuración de Red

### Opción A: Tailscale (Recomendado)

[Tailscale](https://tailscale.com/) crea una red mesh segura entre tus servidores sin necesidad de configurar firewalls.

```bash
# Instalar en ambos servidores
curl -fsSL https://tailscale.com/install.sh | sh

# Autenticar (misma cuenta en ambos)
sudo tailscale up

# Verificar conectividad
tailscale status
# Verás IPs como 100.x.x.x para cada máquina

# Verificar
ping <OTHER_SERVER_TAILSCALE_IP>
```

Usa las IPs `100.x.x.x` de Tailscale en tu configuración A2A. El tráfico está cifrado de extremo a extremo.

### Opción B: LAN

Si ambos servidores están en la misma red local, usa sus IPs de LAN directamente. Asegúrate de que el puerto 18800 sea accesible.

### Opción C: IP Pública

Usa IPs públicas con autenticación por token bearer. Considera agregar reglas de firewall para restringir el acceso a IPs conocidas.

## Ejemplo Completo: Configuración de Dos Servidores

### Configuración del Servidor A

```bash
# Generar el token del Servidor A
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

# Agregar Servidor B como par (usar el token de B)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Configuración del Servidor B

```bash
# Generar el token del Servidor B
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

# Agregar Servidor A como par (usar el token de A)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Verificar ambas direcciones

```bash
# Desde Servidor A → probar el Agent Card del Servidor B
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Desde Servidor B → probar el Agent Card del Servidor A
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Enviar un mensaje A → B (usando el script SDK)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Referencia de Configuración

### Núcleo

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Nombre visible de este agente |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Descripción legible por humanos |
| `agentCard.url` | string | auto | URL del endpoint JSON-RPC |
| `agentCard.skills` | array | `[{chat}]` | Lista de habilidades que ofrece este agente |
| `server.host` | string | `0.0.0.0` | Dirección de enlace |
| `server.port` | number | `18800` | Puerto HTTP para A2A (gRPC en puerto+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Ruta del almacén de tareas duradero en disco |
| `storage.taskTtlHours` | number | `72` | Limpieza automática de tareas expiradas tras N horas |
| `storage.cleanupIntervalMinutes` | number | `60` | Frecuencia de escaneo de tareas expiradas |

### Pares

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Lista de agentes pares |
| `peers[].name` | string | *required* | Nombre visible del par |
| `peers[].agentCardUrl` | string | *required* | URL del Agent Card del par |
| `peers[].auth.type` | string | — | `bearer` o `apiKey` |
| `peers[].auth.token` | string | — | Token de autenticación |

### Seguridad

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` o `bearer` |
| `security.token` | string | — | Token único para autenticación entrante |
| `security.tokens` | array | `[]` | Múltiples tokens para rotación sin tiempo de inactividad |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Patrones MIME permitidos para transferencia de archivos |
| `security.maxFileSizeBytes` | number | `52428800` | Tamaño máximo de archivo basado en URI (50MB) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Tamaño máximo de archivo inline en base64 (10MB) |
| `security.fileUriAllowlist` | array | `[]` | Lista de hostnames de URI permitidos (vacío = permitir todos los públicos) |

### Enrutamiento

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | ID de agente para mensajes entrantes |
| `routing.rules` | array | `[]` | Reglas de enrutamiento basadas en reglas (ver abajo) |
| `routing.rules[].name` | string | *required* | Nombre de la regla |
| `routing.rules[].match.pattern` | string | — | Regex para coincidir con el texto del mensaje (insensible a mayúsculas) |
| `routing.rules[].match.tags` | array | — | Coincidir si el mensaje tiene alguna de estas etiquetas |
| `routing.rules[].match.skills` | array | — | Coincidir si el par de destino tiene alguna de estas habilidades |
| `routing.rules[].target.peer` | string | *required* | Par al que enrutar |
| `routing.rules[].target.agentId` | string | — | Anular el agentId en el par |
| `routing.rules[].priority` | number | `0` | Mayor = se verifica primero |

### Resiliencia

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Habilitar sondas periódicas del Agent Card |
| `resilience.healthCheck.intervalMs` | number | `30000` | Intervalo de sondeo (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Tiempo de espera del sondeo (ms) |
| `resilience.retry.maxRetries` | number | `3` | Reintentos máximos para llamadas salientes fallidas |
| `resilience.retry.baseDelayMs` | number | `1000` | Retardo base para retroceso exponencial |
| `resilience.retry.maxDelayMs` | number | `10000` | Tope máximo de retardo |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Fallos antes de que el circuito se abra |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Enfriamiento antes del sondeo semi-abierto |

### Descubrimiento y Publicación

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Habilitar descubrimiento de pares por DNS-SD |
| `discovery.serviceName` | string | `_a2a._tcp.local` | Nombre de servicio DNS-SD a consultar |
| `discovery.refreshIntervalMs` | number | `30000` | Frecuencia de re-consulta DNS (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Fusionar pares descubiertos con la configuración estática |
| `advertise.enabled` | boolean | `false` | Habilitar auto-publicación mDNS |
| `advertise.serviceName` | string | `_a2a._tcp.local` | Tipo de servicio DNS-SD a publicar |
| `advertise.ttl` | number | `120` | TTL en segundos para los registros publicados |

### Observabilidad

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Emitir logs en JSON estructurado |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Exponer snapshot de telemetría por HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | Ruta HTTP para telemetría |
| `observability.metricsAuth` | string | `none` | `none` o `bearer` para el endpoint de métricas |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Ruta para el log de auditoría JSONL |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Espera máxima para respuesta del agente (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Máximo de ejecuciones de agente entrantes activas |
| `limits.maxQueuedTasks` | number | `100` | Máximo de tareas en cola antes de rechazar |

## Puntos de acceso

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Descubrimiento del Agent Card *(alias: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | Transporte A2A JSON-RPC |
| `/a2a/rest` | POST | Transporte A2A REST |
| `<host>:<port+1>` | gRPC | Transporte A2A gRPC |
| `/a2a/metrics` | GET | Snapshot de telemetría (autenticación bearer opcional) |
| `/a2a/push/register` | POST | Registrar webhook de notificaciones push |
| `/a2a/push/:taskId` | DELETE | Cancelar registro de notificación push |

## Resolución de Problemas

### "Request accepted (no agent dispatch available)"

Esto significa que la solicitud A2A fue aceptada por el gateway, pero el envío al agente subyacente de OpenClaw no se completó.

Causas comunes:

1) **No hay proveedor de IA configurado** en la instancia de OpenClaw de destino.

```bash
openclaw config get auth.profiles
```

2) **El envío al agente expiró** (prompt de larga duración / discusión de múltiples rondas).

Opciones de solución:
- Usar modo de tarea asíncrona desde el emisor: `--non-blocking --wait`
- Aumentar el tiempo de espera del plugin: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (predeterminado: 300000)


### El Agent Card devuelve 404

El plugin no está cargado. Verifica:

```bash
# Verificar que el plugin está en la lista de permitidos
openclaw config get plugins.allow

# Verificar que la ruta de carga es correcta
openclaw config get plugins.load.paths

# Revisar los logs del gateway
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Conexión rechazada en el puerto 18800

```bash
# Verificar si el servidor A2A está escuchando
ss -tlnp | grep 18800

# Si no, reiniciar el gateway
openclaw gateway restart
```

### La autenticación del par falla

Asegúrate de que el token en la configuración de tu par coincida exactamente con el `security.token` del servidor de destino.

## Habilidad del Agente (para OpenClaw / Codex CLI)

Este repositorio incluye una **habilidad** lista para usar en `skill/` que guía a los agentes de IA (OpenClaw, Codex CLI, Claude Code, etc.) a través del proceso completo de configuración de A2A paso a paso, incluyendo instalación, configuración, registro de pares, configuración de TOOLS.md y verificación.

### ¿Por qué usar la habilidad?

Configurar A2A manualmente involucra muchos pasos con nombres de campos específicos, patrones de URL y manejo de tokens. La habilidad codifica todo esto como un procedimiento repetible, previniendo errores comunes como:

- Confundir `agentCard.url` (endpoint JSON-RPC) con `peers[].agentCardUrl` (descubrimiento del Agent Card)
- Olvidar actualizar TOOLS.md (el agente no sabrá cómo llamar a los pares)
- Usar rutas relativas en `plugins.load.paths` (deben ser absolutas)
- Omitir el registro mutuo de pares (ambos lados necesitan la configuración del otro)

### Instalar la habilidad

**Para OpenClaw:**

```bash
# Copiar al directorio de habilidades
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# O crear un enlace simbólico
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Para Codex CLI:**

```bash
# Copiar al directorio de habilidades de Codex
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Para Claude Code:**

```bash
# Copiar a tu proyecto o workspace
cp -r <repo>/skill ./skills/a2a-setup
```

### Contenido de la habilidad

```
skill/
├── SKILL.md                          # Guía de configuración paso a paso
├── scripts/
│   └── a2a-send.mjs                  # Emisor de mensajes basado en SDK (oficial @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # Plantilla de TOOLS.md para el conocimiento A2A del agente
```

La habilidad proporciona dos métodos para que los agentes llamen a los pares:
- **curl** — universal, funciona en todas partes
- **Script SDK** — usa `@a2a-js/sdk` ClientFactory con descubrimiento automático del Agent Card y selección de transporte

### Uso

Una vez instalada, dile a tu agente:

- "Set up A2A gateway" / "Configurar el gateway A2A"
- "Connect this OpenClaw to another server via A2A" / "Conectar este OpenClaw a otro servidor vía A2A"
- "Add an A2A peer" / "Agregar un par A2A"

El agente seguirá el procedimiento de la habilidad automáticamente.

## Diseño bioinspirado

Cuando los ecosistemas multiagente escalan de 2 pares a 20 o 200, las pasarelas A2A estándar encuentran obstáculos predecibles: el enrutamiento elige el par equivocado, los circuit breakers cortan todo el tráfico, el sondeo de descubrimiento desperdicia ancho de banda y la sobrecarga golpea como un precipicio. Esta pasarela resuelve estos problemas con mecanismos tomados de la **biología de señalización celular** — los mismos principios que las células usan para enrutar señales, manejar la sobrecarga de receptores y descubrir vecinos en tejido denso.

| Biología | Mecanismo | Funcionalidad A2A | Referencia |
|----------|-----------|-------------------|------------|
| Unión ligando-receptor | Sigmoide de la ecuación de Hill | **Enrutamiento por puntuación de afinidad** — puntuación multidimensional con pendiente (n) y umbral (Kd) configurables | Hill (1910) *J Physiol* 40 |
| Desensibilización de receptores | Fosforilación → internalización → reciclaje | **Circuit breaker de cuatro estados** — degradación gradual (DESENSITIZED) antes del bloqueo total (OPEN), con curva de recuperación exponencial | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| Degradación del AMPc | Degradación por fosfodiesterasa | **Notificaciones con decaimiento de señal** — la puntuación de importancia decae exponencialmente; reintento abandonado bajo el umbral | Alon (2007) *Intro to Systems Biology* Ch.4 |
| Quorum sensing | Umbral de concentración de autoinductor | **Descubrimiento sensible a la densidad** — sondeo adaptativo con histéresis (modo explore ↔ stable) basado en la población de pares | Tamsir *et al.* (2011) *Nature* 469:212 |
| Selección de vía de señalización | Eficacia × velocidad de transducción | **Transporte adaptativo** — puntuación por transporte según tasa de éxito × factor de latencia; los transportes no probados tienen prioridad de exploración | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Saturación enzimática | Cinética de Michaelis-Menten | **Limitación suave de concurrencia** — retardo progresivo `baseDelay × load/(Km + load)` antes del muro duro de la cola | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Cuándo activar

Todas las funcionalidades bioinspiradas son **opcionales y retrocompatibles** — sin configuración explícita, la pasarela se comporta de forma idéntica a las implementaciones estándar. Actívalas cuando tu despliegue supere los valores predeterminados:

| Funcionalidad | Activar cuando... | Clave de configuración |
|---------------|-------------------|----------------------|
| Enrutamiento por afinidad Hill | 5+ pares con habilidades superpuestas | `routing.affinity` |
| Circuit breaker de cuatro estados | Los pares tienen fallos intermitentes | `resilience.circuitBreaker.softThreshold` |
| Reintento con decaimiento de señal | Los endpoints de webhook son inestables | Activado por defecto |
| Descubrimiento por quorum sensing | Red de pares dinámica con DNS-SD | `discovery.quorum` |
| Transporte adaptativo | Los pares exponen múltiples transportes | Automático (aprende del uso) |
| Concurrencia suave MM | Operaciones de alto rendimiento sub-segundo | `limits.saturation` |

> Benchmark: `node --import tsx --test tests/benchmark.test.ts`

## Historial de Versiones

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | Enrutamiento por habilidades de pares, auto-publicación mDNS (descubrimiento simétrico) |
| **v1.1.0** | Extracción de URLs, respaldo de transporte, notificaciones push, enrutamiento basado en reglas, descubrimiento DNS-SD |
| **v1.0.1** | Identidad de dispositivo Ed25519, autenticación de métricas, CI |
| **v1.0.0** | Listo para producción: persistencia, multi-ronda, transferencia de archivos, SSE, verificaciones de salud, multi-token, auditoría |
| **v0.1.0** | Implementación inicial de A2A v0.3.0 |

Consulta [CHANGELOG.md](CHANGELOG.md) para detalles completos y [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) para descargas.

## Licencia

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
