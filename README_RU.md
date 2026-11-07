[Профиль Bilibili](https://space.bilibili.com/3493277319825652)

# 🦞 Плагин OpenClaw A2A Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Готовый к промышленной эксплуатации плагин для [OpenClaw](https://github.com/openclaw/openclaw), реализующий [протокол A2A (Agent-to-Agent) v0.3.0](https://github.com/google/A2A). Он позволяет агентам OpenClaw обнаруживать друг друга и обмениваться сообщениями между серверами — с установкой без конфигурации и автоматическим обнаружением пиров.

**Единственный A2A-шлюз с адаптивной биоинспирированной маршрутизацией, обнаружением и отказоустойчивостью — разработан для масштабных мультиагентных экосистем.**

## Ключевые возможности

### Транспорт и протокол
- **Три транспорта**: JSON-RPC, REST и gRPC — с автоматическим переключением (пробует JSON-RPC → REST → gRPC)
- **SSE-стриминг** с heartbeat-поддержанием соединения для отслеживания статуса задач в реальном времени
- **Полная поддержка типов Part**: TextPart, FilePart (URI + base64), DataPart (структурированный JSON)
- **Автоматическое извлечение URL**: URL файлов в текстовых ответах агента автоматически преобразуются в исходящие FilePart

### Интеллектуальная маршрутизация
- **Маршрутизация по правилам**: автоматический выбор пира по шаблону сообщения, тегам или навыкам пира
- **Кэширование навыков пиров**: навыки из Agent Card извлекаются при проверке доступности, что позволяет маршрутизировать по навыкам
- **Целевой agentId для каждого сообщения**: направление сообщения конкретному агенту OpenClaw на стороне пира (расширение OpenClaw)

### Обнаружение и отказоустойчивость
- **Обнаружение через DNS-SD**: автоматическое обнаружение пиров по записям `_a2a._tcp` SRV + TXT
- **Самоанонсирование через mDNS**: публикация записей SRV + TXT для автоматического обнаружения другими шлюзами
- **Проверки доступности** с экспоненциальным откатом + автоматическим размыкателем цепи (closed → open → half-open)
- **Push-уведомления**: доставка через webhook при завершении задачи с HMAC + защитой от SSRF

### Безопасность и наблюдаемость
- **Аутентификация по Bearer-токену** с ротацией нескольких токенов без простоя
- **Защита от SSRF**: белый список хостов URI, белый список MIME-типов, ограничение размера файлов
- **Идентификация устройства Ed25519** для совместимости со scope OpenClaw ≥2026.3.13
- **Аудит-лог в формате JSONL** для всех A2A-вызовов и событий безопасности
- **Эндпоинт телеметрии** с опциональной Bearer-аутентификацией
- **Персистентное хранилище задач** на диске с TTL-очисткой и ограничением параллелизма

## Архитектура

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Предварительные требования

- **OpenClaw** ≥ 2026.3.0 установлен и запущен
- **Сетевое подключение** между серверами (Tailscale, LAN или публичный IP)
- **Node.js** ≥ 22

## Установка

### Быстрый старт (без конфигурации)

Плагин поставляется с разумными значениями по умолчанию — вы можете установить и загрузить его **без какой-либо ручной настройки**:

```bash
# Клонирование
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Регистрация и активация
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Перезапуск
openclaw gateway restart

# Проверка
openclaw plugins list          # должен показать a2a-gateway как загруженный
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Плагин запустится с Agent Card по умолчанию (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Вы можете настроить его позже — см. раздел [Настройка Agent Card](#3-настройка-agent-card) ниже.

### Пошаговая установка

Если вы предпочитаете ручное управление или вам нужно сохранить существующие плагины в конфигурации:

### 1. Клонирование плагина

```bash
# В каталог плагинов вашего рабочего пространства
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Регистрация плагина в OpenClaw

```bash
# Добавление в список разрешённых плагинов
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Указание пути к плагину для OpenClaw
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Активация плагина
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Примечание:** Замените `<FULL_PATH_TO>` на фактический абсолютный путь, например `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Сохраните все существующие плагины в массиве `plugins.allow`.

### 3. Настройка Agent Card

Каждому A2A-агенту нужна Agent Card, описывающая его. Если вы пропустите этот шаг, плагин использует значения по умолчанию:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

Для настройки:

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Важно:** Замените `<YOUR_IP>` на IP-адрес, доступный вашим пирам (Tailscale IP, IP в локальной сети или публичный IP).

### 4. Настройка A2A-сервера

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Настройка безопасности (рекомендуется)

Сгенерируйте токен для аутентификации входящих подключений:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Сохраните этот токен — он понадобится пирам для аутентификации на вашем агенте.

### 6. Настройка маршрутизации агентов

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Перезапуск шлюза

```bash
openclaw gateway restart
```

### 8. Проверка

```bash
# Проверка доступности Agent Card
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Вы должны увидеть вашу Agent Card с именем, навыками и URL.

## Добавление пиров

Чтобы обмениваться сообщениями с другим A2A-агентом, добавьте его как пира:

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

Затем перезапустите:

```bash
openclaw gateway restart
```

### Взаимный пиринг (оба направления)

Для двусторонней связи **оба сервера** должны добавить друг друга как пиры:

| Server A | Server B |
|----------|----------|
| Peer: Server-B (с токеном B) | Peer: Server-A (с токеном A) |

Каждый сервер генерирует собственный токен безопасности и передаёт его другому.

## Отправка сообщений через A2A

### Из командной строки

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

Скрипт использует `@a2a-js/sdk` ClientFactory для автоматического обнаружения Agent Card и выбора лучшего транспорта.

### Асинхронный режим задач (рекомендуется для длительных запросов)

Для длительных запросов или многораундовых обсуждений используйте неблокирующий режим + опрос, чтобы избежать блокировки одного запроса:

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

Эта команда отправляет `configuration.blocking=false`, а затем опрашивает `tasks/get` до тех пор, пока задача не достигнет конечного состояния.

Совет: тайм-аут скрипта по умолчанию (`--timeout-ms`) составляет 10 минут; для очень длительных задач переопределите его.

### Адресация конкретного agentId в OpenClaw (расширение OpenClaw)

По умолчанию пир направляет входящие A2A-сообщения на `routing.defaultAgentId` (обычно `main`).

Чтобы направить отдельный запрос конкретному `agentId` OpenClaw на стороне пира, используйте `--agent-id`:

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Это реализовано как нестандартное поле `message.agentId`, понимаемое данным плагином. Наиболее надёжно работает через JSON-RPC/REST. Транспорт gRPC может отбрасывать неизвестные поля Message.

### Осведомлённость агента во время выполнения (TOOLS.md)

Даже если плагин установлен и настроен, LLM-агент не сможет надёжно «угадать», как вызвать A2A-пиров (URL пира, токен, команду для запуска). Для надёжных **исходящих** A2A-вызовов следует добавить раздел A2A в файл `TOOLS.md` агента.

Добавьте следующее в `TOOLS.md` вашего агента, чтобы он знал, как вызывать пиров (полный шаблон см. в `skill/references/tools-md-template.md`):

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

После этого пользователи смогут говорить:
- "Send to PeerName: what's your status?"
- "Ask PeerName to run a health check"

## Типы A2A Part

Плагин поддерживает все три типа A2A Part для входящих сообщений. Поскольку RPC-шлюз OpenClaw принимает только простой текст, каждый тип Part сериализуется в удобочитаемый формат перед передачей агенту.

| Part Type | Format Sent to Agent | Example |
|-----------|---------------------|---------|
| `TextPart` | Необработанный текст | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | Файловая ссылка по URI |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Встроенный файл с указанием размера |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Структурированные данные JSON (обрезаются до 2КБ) |

Для исходящих ответов плагин преобразует структурированные поля `mediaUrl`/`mediaUrls` из payload агента в записи `FilePart` в A2A-ответе. Кроме того, URL файлов, встроенные в текстовый ответ агента (markdown-ссылки вида `[report](https://…/report.pdf)` и голые URL вида `https://…/data.csv`), автоматически извлекаются в записи `FilePart`, если они заканчиваются распознаваемым расширением файла.

### Инструмент агента a2a_send_file

Плагин регистрирует инструмент `a2a_send_file`, который агенты могут вызывать для отправки файлов пирам:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Да | Имя целевого пира (должно совпадать с настроенным пиром) |
| `uri` | Да | Публичный URL файла для отправки |
| `name` | Нет | Имя файла (например, `report.pdf`) |
| `mimeType` | Нет | MIME-тип (автоматически определяется по расширению, если не указан) |
| `text` | Нет | Опциональное текстовое сообщение вместе с файлом |
| `agentId` | Нет | Направить конкретному agentId на стороне пира (расширение OpenClaw) |

Пример взаимодействия агента:
- Пользователь: "Отправь тестовый отчёт на AWS-bot"
- Агент вызывает `a2a_send_file` с `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Настройка сети

### Вариант A: Tailscale (рекомендуется)

[Tailscale](https://tailscale.com/) создаёт защищённую mesh-сеть между вашими серверами без какой-либо настройки файрвола.

```bash
# Установка на обоих серверах
curl -fsSL https://tailscale.com/install.sh | sh

# Аутентификация (один аккаунт на обоих)
sudo tailscale up

# Проверка связи
tailscale status
# Вы увидите IP-адреса вида 100.x.x.x для каждой машины

# Проверка
ping <OTHER_SERVER_TAILSCALE_IP>
```

Используйте IP-адреса Tailscale `100.x.x.x` в конфигурации A2A. Трафик шифруется сквозным образом.

### Вариант B: Локальная сеть (LAN)

Если оба сервера находятся в одной локальной сети, используйте их LAN IP напрямую. Убедитесь, что порт 18800 доступен.

### Вариант C: Публичный IP

Используйте публичные IP-адреса с аутентификацией по Bearer-токену. Рассмотрите возможность добавления правил файрвола для ограничения доступа к известным IP.

## Полный пример: настройка двух серверов

### Настройка сервера A

```bash
# Генерация токена сервера A
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# Настройка A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Добавление сервера B как пира (используя токен B)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Настройка сервера B

```bash
# Генерация токена сервера B
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# Настройка A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Добавление сервера A как пира (используя токен A)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Проверка обоих направлений

```bash
# С сервера A → проверка Agent Card сервера B
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# С сервера B → проверка Agent Card сервера A
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Отправка сообщения A → B (с использованием SDK-скрипта)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Справочник по конфигурации

### Основные параметры

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Отображаемое имя агента |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Описание в человекочитаемом формате |
| `agentCard.url` | string | auto | URL эндпоинта JSON-RPC |
| `agentCard.skills` | array | `[{chat}]` | Список навыков, предоставляемых агентом |
| `server.host` | string | `0.0.0.0` | Адрес привязки |
| `server.port` | number | `18800` | HTTP-порт A2A (gRPC на port+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Путь к персистентному хранилищу задач на диске |
| `storage.taskTtlHours` | number | `72` | Автоочистка просроченных задач через N часов |
| `storage.cleanupIntervalMinutes` | number | `60` | Частота сканирования просроченных задач |

### Пиры

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Список агентов-пиров |
| `peers[].name` | string | *required* | Отображаемое имя пира |
| `peers[].agentCardUrl` | string | *required* | URL Agent Card пира |
| `peers[].auth.type` | string | — | `bearer` или `apiKey` |
| `peers[].auth.token` | string | — | Токен аутентификации |

### Безопасность

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` или `bearer` |
| `security.token` | string | — | Одиночный токен для входящей аутентификации |
| `security.tokens` | array | `[]` | Несколько токенов для ротации без простоя |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Разрешённые MIME-шаблоны для передачи файлов |
| `security.maxFileSizeBytes` | number | `52428800` | Макс. размер файла по URI (50МБ) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Макс. размер встроенного base64-файла (10МБ) |
| `security.fileUriAllowlist` | array | `[]` | Белый список хостов URI (пустой = разрешить все публичные) |

### Маршрутизация

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | ID агента для входящих сообщений |
| `routing.rules` | array | `[]` | Правила маршрутизации на основе правил (см. ниже) |
| `routing.rules[].name` | string | *required* | Имя правила |
| `routing.rules[].match.pattern` | string | — | Регулярное выражение для текста сообщения (регистронезависимое) |
| `routing.rules[].match.tags` | array | — | Совпадение, если у сообщения есть хотя бы один из этих тегов |
| `routing.rules[].match.skills` | array | — | Совпадение, если у целевого пира есть хотя бы один из этих навыков |
| `routing.rules[].target.peer` | string | *required* | Пир для маршрутизации |
| `routing.rules[].target.agentId` | string | — | Переопределение agentId на стороне пира |
| `routing.rules[].priority` | number | `0` | Выше = проверяется первым |

### Отказоустойчивость

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Включить периодические проверки Agent Card |
| `resilience.healthCheck.intervalMs` | number | `30000` | Интервал проверки (мс) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Тайм-аут проверки (мс) |
| `resilience.retry.maxRetries` | number | `3` | Макс. количество повторов для неудачных исходящих вызовов |
| `resilience.retry.baseDelayMs` | number | `1000` | Базовая задержка для экспоненциального отката |
| `resilience.retry.maxDelayMs` | number | `10000` | Максимальное ограничение задержки |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Количество сбоев до размыкания цепи |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Пауза перед полуоткрытой проверкой |

### Обнаружение и анонсирование

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Включить обнаружение пиров через DNS-SD |
| `discovery.serviceName` | string | `_a2a._tcp.local` | Имя сервиса DNS-SD для запроса |
| `discovery.refreshIntervalMs` | number | `30000` | Частота повторного запроса DNS (мс) |
| `discovery.mergeWithStatic` | boolean | `true` | Объединять обнаруженных пиров со статической конфигурацией |
| `advertise.enabled` | boolean | `false` | Включить самоанонсирование через mDNS |
| `advertise.serviceName` | string | `_a2a._tcp.local` | Тип сервиса DNS-SD для анонсирования |
| `advertise.ttl` | number | `120` | TTL в секундах для анонсируемых записей |

### Наблюдаемость

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Выводить структурированные логи в формате JSON |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Открыть снимок телеметрии по HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | HTTP-путь для телеметрии |
| `observability.metricsAuth` | string | `none` | `none` или `bearer` для эндпоинта метрик |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Путь для JSONL аудит-лога |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Макс. ожидание ответа агента (мс) |
| `limits.maxConcurrentTasks` | number | `4` | Макс. количество активных входящих запусков агентов |
| `limits.maxQueuedTasks` | number | `100` | Макс. количество задач в очереди до отклонения |

## Эндпоинты

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Обнаружение Agent Card *(псевдоним: `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | A2A транспорт JSON-RPC |
| `/a2a/rest` | POST | A2A транспорт REST |
| `<host>:<port+1>` | gRPC | A2A транспорт gRPC |
| `/a2a/metrics` | GET | Снимок телеметрии (опциональная Bearer-аутентификация) |
| `/a2a/push/register` | POST | Регистрация webhook для push-уведомлений |
| `/a2a/push/:taskId` | DELETE | Отмена регистрации push-уведомлений |

## Устранение неполадок

### "Request accepted (no agent dispatch available)"

Это означает, что A2A-запрос был принят шлюзом, но нижележащая диспетчеризация агента OpenClaw не завершилась.

Распространённые причины:

1) **Не настроен провайдер ИИ** на целевом экземпляре OpenClaw.

```bash
openclaw config get auth.profiles
```

2) **Тайм-аут диспетчеризации агента** (длительный запрос / многораундовое обсуждение).

Варианты решения:
- Используйте асинхронный режим задач на стороне отправителя: `--non-blocking --wait`
- Увеличьте тайм-аут плагина: `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (по умолчанию: 300000)


### Agent Card возвращает 404

Плагин не загружен. Проверьте:

```bash
# Убедитесь, что плагин в списке разрешённых
openclaw config get plugins.allow

# Проверьте правильность пути загрузки
openclaw config get plugins.load.paths

# Проверьте логи шлюза
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Отказ в подключении на порту 18800

```bash
# Проверьте, слушает ли A2A-сервер
ss -tlnp | grep 18800

# Если нет, перезапустите шлюз
openclaw gateway restart
```

### Ошибка аутентификации пира

Убедитесь, что токен в вашей конфигурации пира точно совпадает с `security.token` на целевом сервере.

## Навык агента (для OpenClaw / Codex CLI)

Этот репозиторий включает готовый к использованию **навык** в каталоге `skill/`, который пошагово проводит AI-агентов (OpenClaw, Codex CLI, Claude Code и др.) через полный процесс настройки A2A — включая установку, конфигурацию, регистрацию пиров, настройку TOOLS.md и проверку.

### Зачем использовать навык?

Ручная настройка A2A включает множество шагов с определёнными именами полей, шаблонами URL и обработкой токенов. Навык кодирует всё это в виде воспроизводимой процедуры, предотвращая типичные ошибки, такие как:

- Путаница между `agentCard.url` (эндпоинт JSON-RPC) и `peers[].agentCardUrl` (обнаружение Agent Card)
- Забытое обновление TOOLS.md (агент не будет знать, как вызывать пиров)
- Использование относительных путей в `plugins.load.paths` (должны быть абсолютными)
- Пропуск взаимной регистрации пиров (обе стороны должны иметь конфигурацию друг друга)

### Установка навыка

**Для OpenClaw:**

```bash
# Скопируйте в каталог навыков
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Или создайте символическую ссылку
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Для Codex CLI:**

```bash
# Скопируйте в каталог навыков Codex
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Для Claude Code:**

```bash
# Скопируйте в ваш проект или рабочее пространство
cp -r <repo>/skill ./skills/a2a-setup
```

### Содержимое навыка

```
skill/
├── SKILL.md                          # Пошаговое руководство по настройке
├── scripts/
│   └── a2a-send.mjs                  # Отправитель сообщений на базе SDK (официальный @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # Шаблон TOOLS.md для осведомлённости агента об A2A
```

Навык предоставляет два метода для вызова пиров агентами:
- **curl** — универсальный, работает везде
- **SDK-скрипт** — использует `@a2a-js/sdk` ClientFactory с автоматическим обнаружением Agent Card и выбором транспорта

### Использование

После установки скажите вашему агенту:

- "Set up A2A gateway" / "Настрой A2A-шлюз"
- "Connect this OpenClaw to another server via A2A"
- "Add an A2A peer"

Агент автоматически выполнит процедуру навыка.

## Биоинспирированный дизайн

По мере масштабирования мультиагентных экосистем от 2 пиров до 20 или 200, стандартные A2A-шлюзы упираются в предсказуемые ограничения: маршрутизация выбирает не тот пир, размыкатели цепи полностью блокируют трафик, опрос обнаружения расходует полосу пропускания, а перегрузка ударяет как стена. Этот шлюз решает эти проблемы с помощью механизмов, заимствованных из **биологии клеточной сигнализации** — тех же принципов, которые клетки используют для маршрутизации сигналов, обработки перегрузки рецепторов и обнаружения соседей в плотных тканях.

| Биология | Механизм | Функция A2A | Ссылка |
|----------|----------|-------------|--------|
| Связывание лиганд-рецептор | Сигмоида уравнения Хилла | **Маршрутизация по аффинности** — многомерная оценка совпадения с настраиваемой крутизной (n) и порогом (Kd) | Hill (1910) *J Physiol* 40 |
| Десенсибилизация рецепторов | Фосфорилирование → интернализация → рециклинг | **Четырёхфазный размыкатель цепи** — постепенная деградация (DESENSITIZED) перед полной блокировкой (OPEN), с экспоненциальной кривой восстановления | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| Деградация cAMP | Ферментативный распад фосфодиэстеразой | **Уведомления с затуханием сигнала** — оценка важности экспоненциально затухает; повторная попытка прекращается при падении ниже порога | Alon (2007) *Intro to Systems Biology* Гл.4 |
| Кворумное зондирование | Пороговая концентрация автоиндуктора | **Обнаружение с учётом плотности** — адаптивный опрос с гистерезисом (режим исследования ↔ стабильный режим) на основе популяции пиров | Tamsir *et al.* (2011) *Nature* 469:212 |
| Выбор сигнального пути | Эффективность пути × скорость трансдукции | **Адаптивный транспорт** — оценка каждого транспорта по проценту успеха × коэффициент задержки; непроверенные пути получают приоритет исследования | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Насыщение ферментов | Кинетика Михаэлиса-Ментен | **Мягкое ограничение параллелизма** — прогрессивная задержка `baseDelay × load/(Km + load)` перед жёстким пределом очереди | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Когда включать

Все биоинспирированные функции **опциональны и обратно совместимы** — без явной конфигурации шлюз ведёт себя идентично стандартным реализациям. Включайте их, когда ваше развёртывание перерастает настройки по умолчанию:

| Функция | Включить когда... | Ключ конфигурации |
|---------|---------------------|-------------------|
| Маршрутизация по аффинности Хилла | 5+ пиров с пересекающимися навыками | `routing.affinity` |
| Четырёхфазный размыкатель цепи | У пиров перемежающиеся сбои | `resilience.circuitBreaker.softThreshold` |
| Повтор с затуханием сигнала | Webhook-эндпоинты ненадёжны | Включено по умолчанию |
| Обнаружение с кворумным зондированием | Динамические сети пиров с DNS-SD | `discovery.quorum` |
| Адаптивный транспорт | Пиры предоставляют несколько транспортов | Автоматически (обучается на использовании) |
| Мягкий параллелизм ММ | Высокопроизводительные операции менее секунды | `limits.saturation` |

> Benchmark: `node --import tsx --test tests/benchmark.test.ts`

## История версий

| Version | Highlights |
|---------|-----------|
| **v1.2.0** | Маршрутизация по навыкам пиров, самоанонсирование через mDNS (симметричное обнаружение) |
| **v1.1.0** | Извлечение URL, переключение транспорта, push-уведомления, маршрутизация по правилам, обнаружение через DNS-SD |
| **v1.0.1** | Идентификация устройства Ed25519, аутентификация метрик, CI |
| **v1.0.0** | Промышленная готовность: персистентность, многораундовый режим, передача файлов, SSE, проверки доступности, мульти-токены, аудит |
| **v0.1.0** | Первоначальная реализация A2A v0.3.0 |

Подробности см. в [CHANGELOG.md](CHANGELOG.md), загрузки — в [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases).

## Лицензия

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
