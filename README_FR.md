# 🦞 Plugin OpenClaw A2A Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)
[![Tests](https://img.shields.io/badge/tests-469%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)]()

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

Un plugin [OpenClaw](https://github.com/openclaw/openclaw) prêt pour la production qui implémente le [protocole A2A (Agent-to-Agent) v0.3.0](https://github.com/google/A2A), permettant aux agents OpenClaw de se découvrir et de communiquer entre eux sur différents serveurs — avec une installation sans configuration et une découverte automatique des pairs.

**La seule passerelle A2A dotée d'un routage, d'une découverte et d'une résilience adaptatifs bio-inspirés — conçue pour les écosystèmes multi-agents à grande échelle.**

## Fonctionnalités clés

### Transport et protocole
- **Trois transports** : JSON-RPC, REST et gRPC — avec basculement automatique (essaie JSON-RPC → REST → gRPC)
- **Streaming SSE** avec maintien de connexion par heartbeat pour le suivi en temps réel des tâches
- **Support complet des types Part** : TextPart, FilePart (URI + base64), DataPart (JSON structuré)
- **Extraction automatique d'URL** : les URL de fichiers dans les réponses textuelles de l'agent sont promues en FileParts sortants

### Routage intelligent
- **Routage basé sur des règles** : sélection automatique du pair par motif de message, tags ou compétences du pair
- **Cache des compétences des pairs** : les compétences de l'Agent Card sont extraites lors des contrôles de santé, permettant un routage basé sur les compétences
- **Ciblage par agentId par message** : routage vers des agents OpenClaw spécifiques sur le pair (extension OpenClaw)

### Découverte et résilience
- **Découverte DNS-SD** : découverte automatique des pairs via les enregistrements SRV + TXT `_a2a._tcp`
- **Auto-annonce mDNS** : publication d'enregistrements SRV + TXT pour que d'autres passerelles vous trouvent automatiquement
- **Contrôles de santé** avec backoff exponentiel + disjoncteur (fermé → ouvert → semi-ouvert)
- **Notifications push** : livraison par webhook à la fin des tâches avec validation HMAC + SSRF

### Sécurité et observabilité
- **Authentification par jeton Bearer** avec rotation multi-jetons sans interruption de service
- **Protection SSRF** : liste blanche de noms d'hôtes URI, liste blanche MIME, limites de taille de fichier
- **Identité de périphérique Ed25519** pour la compatibilité avec les scopes OpenClaw ≥2026.3.13
- **Journal d'audit JSONL** pour tous les appels A2A et événements de sécurité
- **Endpoint de métriques de télémétrie** avec authentification Bearer optionnelle
- **Stockage durable des tâches** sur disque avec nettoyage TTL et limites de concurrence

## Architecture

```
┌──────────────────────┐         A2A/JSON-RPC          ┌──────────────────────┐
│    OpenClaw Server A  │ ◄──────────────────────────► │    OpenClaw Server B  │
│                       │      (Tailscale / LAN)       │                       │
│  Agent: AGI           │                               │  Agent: Coco          │
│  A2A Port: 18800      │                               │  A2A Port: 18800      │
│  Peer: Server-B       │                               │  Peer: Server-A       │
└──────────────────────┘                               └──────────────────────┘
```

## Prérequis

- **OpenClaw** ≥ 2026.3.0 installé et en cours d'exécution
- **Connectivité réseau** entre les serveurs (Tailscale, LAN ou IP publique)
- **Node.js** ≥ 22

## Installation

### Démarrage rapide (sans configuration)

Le plugin est livré avec des paramètres par défaut raisonnables — vous pouvez l'installer et le charger **sans aucune configuration manuelle** :

```bash
# Cloner
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production

# Enregistrer et activer
openclaw plugins install ~/.openclaw/workspace/plugins/a2a-gateway

# Redémarrer
openclaw gateway restart

# Vérifier
openclaw plugins list          # devrait afficher a2a-gateway comme chargé
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Le plugin démarrera avec l'Agent Card par défaut (`name: "OpenClaw A2A Gateway"`, `skills: [chat]`). Vous pourrez le personnaliser ultérieurement — voir [Configurer l'Agent Card](#3-configurer-lagent-card) ci-dessous.

### Installation étape par étape

Si vous préférez un contrôle manuel ou devez conserver des plugins existants dans votre configuration :

### 1. Cloner le plugin

```bash
# Dans le répertoire des plugins de votre workspace
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/win4r/openclaw-a2a-gateway.git a2a-gateway
cd a2a-gateway
npm install --production
```

### 2. Enregistrer le plugin dans OpenClaw

```bash
# Ajouter à la liste des plugins autorisés
openclaw config set plugins.allow '["telegram", "a2a-gateway"]'

# Indiquer à OpenClaw où trouver le plugin
openclaw config set plugins.load.paths '["<FULL_PATH_TO>/plugins/a2a-gateway"]'

# Activer le plugin
openclaw config set plugins.entries.a2a-gateway.enabled true
```

> **Remarque :** Remplacez `<FULL_PATH_TO>` par le chemin absolu réel, par exemple `/home/ubuntu/.openclaw/workspace/plugins/a2a-gateway`. Conservez les plugins existants dans le tableau `plugins.allow`.

### 3. Configurer l'Agent Card

Chaque agent A2A a besoin d'une Agent Card qui le décrit. Si vous sautez cette étape, le plugin utilise ces valeurs par défaut :

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{"id":"chat","name":"chat","description":"Chat bridge"}]` |

Pour personnaliser :

```bash
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://<YOUR_IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Bridge chat/messages to OpenClaw agents"}]'
```

> **Important :** Remplacez `<YOUR_IP>` par l'adresse IP accessible par vos pairs (IP Tailscale, IP LAN ou IP publique).

### 4. Configurer le serveur A2A

```bash
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
```

### 5. Configurer la sécurité (recommandé)

Générez un jeton pour l'authentification entrante :

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A token: $TOKEN"

openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$TOKEN"
```

> Conservez ce jeton — les pairs en auront besoin pour s'authentifier auprès de votre agent.

### 6. Configurer le routage des agents

```bash
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'
```

### 7. Redémarrer la passerelle

```bash
openclaw gateway restart
```

### 8. Vérifier

```bash
# Vérifier que l'Agent Card est accessible
curl -s http://localhost:18800/.well-known/agent-card.json | python3 -m json.tool
```

Vous devriez voir votre Agent Card avec le nom, les compétences et l'URL.

## Ajout de pairs

Pour communiquer avec un autre agent A2A, ajoutez-le en tant que pair :

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

Puis redémarrez :

```bash
openclaw gateway restart
```

### Appairage mutuel (dans les deux sens)

Pour une communication bidirectionnelle, **les deux serveurs** doivent s'ajouter mutuellement comme pairs :

| Serveur A | Serveur B |
|-----------|-----------|
| Pair : Server-B (avec le jeton de B) | Pair : Server-A (avec le jeton de A) |

Chaque serveur génère son propre jeton de sécurité et le partage avec l'autre.

## Envoi de messages via A2A

### Depuis la ligne de commande

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --message "Hello from Server A!"
```

Le script utilise le ClientFactory de `@a2a-js/sdk` pour découvrir automatiquement l'Agent Card et sélectionner le meilleur transport.

### Mode tâche asynchrone (recommandé pour les requêtes longues)

Pour les requêtes longues ou les discussions multi-tours, évitez de bloquer une seule requête. Utilisez le mode non-bloquant + interrogation :

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

Cela envoie `configuration.blocking=false` puis interroge `tasks/get` jusqu'à ce que la tâche atteigne un état terminal.

Astuce : le `--timeout-ms` par défaut du script est de 10 minutes ; augmentez-le pour les tâches très longues.

### Cibler un agentId OpenClaw spécifique (extension OpenClaw)

Par défaut, le pair route les messages A2A entrants vers `routing.defaultAgentId` (souvent `main`).

Pour router une requête unique vers un `agentId` OpenClaw spécifique sur le pair, utilisez `--agent-id` :

```bash
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://<PEER_IP>:18800 \
  --token <PEER_TOKEN> \
  --agent-id coder \
  --message "Run a health check"
```

Ceci est implémenté comme un champ non standard `message.agentId` compris par ce plugin. Il est plus fiable via JSON-RPC/REST. Le transport gRPC peut ignorer les champs Message inconnus.

### Prise de conscience de l'agent au moment de l'exécution (TOOLS.md)

Même si le plugin est installé et configuré, un agent LLM ne pourra pas « deviner » de manière fiable comment appeler les pairs A2A (URL du pair, jeton, commande à exécuter). Pour des appels A2A **sortants** fiables, vous devez ajouter une section A2A au `TOOLS.md` de l'agent.

Ajoutez ceci au `TOOLS.md` de votre agent pour qu'il sache comment appeler les pairs (voir `skill/references/tools-md-template.md` pour le modèle complet) :

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

Les utilisateurs pourront alors dire des choses comme :
- « Envoie à PeerName : quel est ton statut ? »
- « Demande à PeerName de faire un contrôle de santé »

## Types de Parts A2A

Le plugin prend en charge les trois types de Parts A2A pour les messages entrants. Comme le RPC OpenClaw Gateway n'accepte que du texte brut, chaque type de Part est sérialisé dans un format lisible par l'humain avant d'être transmis à l'agent.

| Type de Part | Format envoyé à l'agent | Exemple |
|--------------|------------------------|---------|
| `TextPart` | Texte brut | `Hello world` |
| `FilePart` (URI) | `[Attached: report.pdf (application/pdf) → https://...]` | Référence de fichier basée sur URI |
| `FilePart` (base64) | `[Attached: photo.png (image/png), inline 45KB]` | Fichier en ligne avec indication de taille |
| `DataPart` | `[Data (application/json): {"key":"value"}]` | Données JSON structurées (tronquées à 2 Ko) |

Pour les réponses sortantes, le plugin convertit les champs structurés `mediaUrl`/`mediaUrls` de la charge utile de l'agent en entrées `FilePart` dans la réponse A2A. De plus, les URL de fichiers intégrées dans la réponse textuelle de l'agent (liens markdown comme `[report](https://…/report.pdf)` et URL nues comme `https://…/data.csv`) sont automatiquement extraites en entrées `FilePart` lorsqu'elles se terminent par une extension de fichier reconnue.

### Outil d'agent a2a_send_file

Le plugin enregistre un outil `a2a_send_file` que les agents peuvent appeler pour envoyer des fichiers aux pairs :

| Parameter | Required | Description |
|-----------|----------|-------------|
| `peer` | Oui | Nom du pair cible (doit correspondre à un pair configuré) |
| `uri` | Oui | URL publique du fichier à envoyer |
| `name` | Non | Nom du fichier (ex. `report.pdf`) |
| `mimeType` | Non | Type MIME (détecté automatiquement depuis l'extension si omis) |
| `text` | Non | Message texte optionnel accompagnant le fichier |
| `agentId` | Non | Routage vers un agentId spécifique sur le pair (extension OpenClaw) |

Exemple d'interaction avec l'agent :
- Utilisateur : « Envoie le rapport de test à AWS-bot »
- L'agent appelle `a2a_send_file` avec `peer: "AWS-bot"`, `uri: "https://..."`, `name: "report.pdf"`

## Configuration réseau

### Option A : Tailscale (recommandé)

[Tailscale](https://tailscale.com/) crée un réseau maillé sécurisé entre vos serveurs sans aucune configuration de pare-feu.

```bash
# Installer sur les deux serveurs
curl -fsSL https://tailscale.com/install.sh | sh

# S'authentifier (même compte sur les deux)
sudo tailscale up

# Vérifier la connectivité
tailscale status
# Vous verrez des IP comme 100.x.x.x pour chaque machine

# Vérifier
ping <OTHER_SERVER_TAILSCALE_IP>
```

Utilisez les IP Tailscale `100.x.x.x` dans votre configuration A2A. Le trafic est chiffré de bout en bout.

### Option B : LAN

Si les deux serveurs sont sur le même réseau local, utilisez directement leurs IP LAN. Assurez-vous que le port 18800 est accessible.

### Option C : IP publique

Utilisez des IP publiques avec une authentification par jeton Bearer. Envisagez d'ajouter des règles de pare-feu pour restreindre l'accès aux IP connues.

## Exemple complet : configuration à deux serveurs

### Configuration du serveur A

```bash
# Générer le jeton du serveur A
A_TOKEN=$(openssl rand -hex 24)
echo "Server A token: $A_TOKEN"

# Configurer A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Ajouter le serveur B comme pair (utiliser le jeton de B)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Configuration du serveur B

```bash
# Générer le jeton du serveur B
B_TOKEN=$(openssl rand -hex 24)
echo "Server B token: $B_TOKEN"

# Configurer A2A
openclaw config set plugins.entries.a2a-gateway.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.a2a-gateway.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.a2a-gateway.config.server.host '0.0.0.0'
openclaw config set plugins.entries.a2a-gateway.config.server.port 18800
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.a2a-gateway.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.a2a-gateway.config.routing.defaultAgentId 'main'

# Ajouter le serveur A comme pair (utiliser le jeton de A)
openclaw config set plugins.entries.a2a-gateway.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

### Vérifier dans les deux sens

```bash
# Depuis le serveur A → tester l'Agent Card du serveur B
curl -s http://100.10.10.2:18800/.well-known/agent-card.json

# Depuis le serveur B → tester l'Agent Card du serveur A
curl -s http://100.10.10.1:18800/.well-known/agent-card.json

# Envoyer un message A → B (en utilisant le script SDK)
node <PLUGIN_PATH>/skill/scripts/a2a-send.mjs \
  --peer-url http://100.10.10.2:18800 \
  --token <B_TOKEN> \
  --message "Hello from Server A!"
```

## Référence de configuration

### Noyau

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Nom d'affichage de cet agent |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Description lisible par l'humain |
| `agentCard.url` | string | auto | URL de l'endpoint JSON-RPC |
| `agentCard.skills` | array | `[{chat}]` | Liste des compétences offertes par cet agent |
| `server.host` | string | `0.0.0.0` | Adresse de liaison |
| `server.port` | number | `18800` | Port HTTP A2A (gRPC sur port+1) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Chemin du stockage durable des tâches sur disque |
| `storage.taskTtlHours` | number | `72` | Nettoyage automatique des tâches expirées après N heures |
| `storage.cleanupIntervalMinutes` | number | `60` | Fréquence d'analyse des tâches expirées |

### Pairs

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `peers` | array | `[]` | Liste des agents pairs |
| `peers[].name` | string | *requis* | Nom d'affichage du pair |
| `peers[].agentCardUrl` | string | *requis* | URL de l'Agent Card du pair |
| `peers[].auth.type` | string | — | `bearer` ou `apiKey` |
| `peers[].auth.token` | string | — | Jeton d'authentification |

### Sécurité

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `security.inboundAuth` | string | `none` | `none` ou `bearer` |
| `security.token` | string | — | Jeton unique pour l'authentification entrante |
| `security.tokens` | array | `[]` | Jetons multiples pour la rotation sans interruption |
| `security.allowedMimeTypes` | array | `[image/*, application/pdf, ...]` | Motifs MIME autorisés pour le transfert de fichiers |
| `security.maxFileSizeBytes` | number | `52428800` | Taille maximale des fichiers basés sur URI (50 Mo) |
| `security.maxInlineFileSizeBytes` | number | `10485760` | Taille maximale des fichiers base64 en ligne (10 Mo) |
| `security.fileUriAllowlist` | array | `[]` | Liste blanche de noms d'hôtes URI (vide = autoriser tout public) |

### Routage

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `routing.defaultAgentId` | string | `default` | ID d'agent pour les messages entrants |
| `routing.rules` | array | `[]` | Règles de routage basées sur des règles (voir ci-dessous) |
| `routing.rules[].name` | string | *requis* | Nom de la règle |
| `routing.rules[].match.pattern` | string | — | Regex pour correspondre au texte du message (insensible à la casse) |
| `routing.rules[].match.tags` | array | — | Correspondance si le message a l'un de ces tags |
| `routing.rules[].match.skills` | array | — | Correspondance si le pair cible possède l'une de ces compétences |
| `routing.rules[].target.peer` | string | *requis* | Pair vers lequel router |
| `routing.rules[].target.agentId` | string | — | Remplacer l'agentId sur le pair |
| `routing.rules[].priority` | number | `0` | Plus élevé = vérifié en premier |

### Résilience

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `resilience.healthCheck.enabled` | boolean | `true` | Activer les sondes périodiques d'Agent Card |
| `resilience.healthCheck.intervalMs` | number | `30000` | Intervalle entre les sondes (ms) |
| `resilience.healthCheck.timeoutMs` | number | `5000` | Délai d'expiration des sondes (ms) |
| `resilience.retry.maxRetries` | number | `3` | Nombre maximal de tentatives pour les appels sortants échoués |
| `resilience.retry.baseDelayMs` | number | `1000` | Délai de base pour le backoff exponentiel |
| `resilience.retry.maxDelayMs` | number | `10000` | Plafond du délai maximum |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Échecs avant ouverture du circuit |
| `resilience.circuitBreaker.resetTimeoutMs` | number | `30000` | Temps de refroidissement avant la sonde semi-ouverte |

### Découverte et annonce

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `discovery.enabled` | boolean | `false` | Activer la découverte de pairs DNS-SD |
| `discovery.serviceName` | string | `_a2a._tcp.local` | Nom de service DNS-SD à interroger |
| `discovery.refreshIntervalMs` | number | `30000` | Fréquence de ré-interrogation DNS (ms) |
| `discovery.mergeWithStatic` | boolean | `true` | Fusionner les pairs découverts avec la configuration statique |
| `advertise.enabled` | boolean | `false` | Activer l'auto-annonce mDNS |
| `advertise.serviceName` | string | `_a2a._tcp.local` | Type de service DNS-SD à annoncer |
| `advertise.ttl` | number | `120` | TTL en secondes pour les enregistrements annoncés |

### Observabilité

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `observability.structuredLogs` | boolean | `true` | Émettre des logs JSON structurés |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Exposer un instantané de télémétrie via HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | Chemin HTTP pour la télémétrie |
| `observability.metricsAuth` | string | `none` | `none` ou `bearer` pour l'endpoint de métriques |
| `observability.auditLogPath` | string | `~/.openclaw/a2a-audit.jsonl` | Chemin du journal d'audit JSONL |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Délai d'attente maximal pour la réponse de l'agent (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Nombre maximal de tâches entrantes actives |
| `limits.maxQueuedTasks` | number | `100` | Nombre maximal de tâches en file d'attente avant rejet |

## Points de terminaison

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Découverte de l'Agent Card *(alias : `/.well-known/agent.json`)* |
| `/a2a/jsonrpc` | POST | Transport A2A JSON-RPC |
| `/a2a/rest` | POST | Transport A2A REST |
| `<host>:<port+1>` | gRPC | Transport A2A gRPC |
| `/a2a/metrics` | GET | Instantané de télémétrie (authentification Bearer optionnelle) |
| `/a2a/push/register` | POST | Enregistrer un webhook de notification push |
| `/a2a/push/:taskId` | DELETE | Désenregistrer une notification push |

## Dépannage

### « Request accepted (no agent dispatch available) »

Cela signifie que la requête A2A a été acceptée par la passerelle, mais que la distribution à l'agent OpenClaw sous-jacent n'a pas abouti.

Causes courantes :

1) **Aucun fournisseur d'IA configuré** sur l'instance OpenClaw cible.

```bash
openclaw config get auth.profiles
```

2) **La distribution à l'agent a expiré** (requête longue / discussion multi-tours).

Options de correction :
- Utilisez le mode tâche asynchrone depuis l'expéditeur : `--non-blocking --wait`
- Augmentez le délai d'expiration du plugin : `plugins.entries.a2a-gateway.config.timeouts.agentResponseTimeoutMs` (par défaut : 300000)


### L'Agent Card retourne 404

Le plugin n'est pas chargé. Vérifiez :

```bash
# Vérifier que le plugin est dans la liste autorisée
openclaw config get plugins.allow

# Vérifier que le chemin de chargement est correct
openclaw config get plugins.load.paths

# Consulter les logs de la passerelle
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep a2a
```

### Connexion refusée sur le port 18800

```bash
# Vérifier si le serveur A2A écoute
ss -tlnp | grep 18800

# Sinon, redémarrer la passerelle
openclaw gateway restart
```

### L'authentification du pair échoue

Assurez-vous que le jeton dans votre configuration de pair correspond exactement au `security.token` du serveur cible.

## Skill d'agent (pour OpenClaw / Codex CLI)

Ce dépôt inclut un **skill** prêt à l'emploi dans `skill/` qui guide les agents IA (OpenClaw, Codex CLI, Claude Code, etc.) à travers l'ensemble du processus de configuration A2A étape par étape — incluant l'installation, la configuration, l'enregistrement des pairs, la configuration de TOOLS.md et la vérification.

### Pourquoi utiliser le skill ?

La configuration manuelle d'A2A implique de nombreuses étapes avec des noms de champs spécifiques, des motifs d'URL et une gestion de jetons. Le skill encode tout cela comme une procédure reproductible, évitant les erreurs courantes telles que :

- Confondre `agentCard.url` (endpoint JSON-RPC) avec `peers[].agentCardUrl` (découverte de l'Agent Card)
- Oublier de mettre à jour TOOLS.md (l'agent ne saura pas comment appeler les pairs)
- Utiliser des chemins relatifs dans `plugins.load.paths` (ils doivent être absolus)
- Oublier l'enregistrement mutuel des pairs (les deux côtés ont besoin de la configuration de l'autre)

### Installer le skill

**Pour OpenClaw :**

```bash
# Copier dans votre répertoire de skills
cp -r <repo>/skill ~/.openclaw/workspace/skills/a2a-setup

# Ou créer un lien symbolique
ln -s $(pwd)/skill ~/.openclaw/workspace/skills/a2a-setup
```

**Pour Codex CLI :**

```bash
# Copier dans le répertoire de skills de Codex
cp -r <repo>/skill ~/.codex/skills/a2a-setup
```

**Pour Claude Code :**

```bash
# Copier dans votre projet ou workspace
cp -r <repo>/skill ./skills/a2a-setup
```

### Contenu du skill

```
skill/
├── SKILL.md                          # Guide de configuration étape par étape
├── scripts/
│   └── a2a-send.mjs                  # Envoi de messages basé sur le SDK (officiel @a2a-js/sdk)
└── references/
    └── tools-md-template.md          # Modèle TOOLS.md pour la prise de conscience A2A de l'agent
```

Le skill fournit deux méthodes pour que les agents appellent les pairs :
- **curl** — universel, fonctionne partout
- **Script SDK** — utilise le ClientFactory de `@a2a-js/sdk` avec découverte automatique de l'Agent Card et sélection du transport

### Utilisation

Une fois installé, dites à votre agent :

- « Set up A2A gateway » / « Configurer la passerelle A2A »
- « Connect this OpenClaw to another server via A2A »
- « Add an A2A peer »

L'agent suivra automatiquement la procédure du skill.

## Conception bio-inspirée

Lorsque les écosystèmes multi-agents passent de 2 pairs à 20, voire 200, les passerelles A2A standard rencontrent des obstacles prévisibles : le routage choisit le mauvais pair, les disjoncteurs coupent tout le trafic, les sondages de découverte gaspillent la bande passante et la surcharge survient comme une falaise. Cette passerelle résout ces problèmes grâce à des mécanismes empruntés à la **biologie de la signalisation cellulaire** — les mêmes principes que les cellules utilisent pour router les signaux, gérer la surcharge des récepteurs et découvrir les voisins dans les tissus denses.

| Biologie | Mécanisme | Fonctionnalité A2A | Référence |
|----------|-----------|-------------------|-----------|
| Liaison ligand-récepteur | Sigmoïde de l'équation de Hill | **Routage par score d'affinité** — scoring multi-dimensionnel avec pente (n) et seuil (Kd) configurables | Hill (1910) *J Physiol* 40 |
| Désensibilisation des récepteurs | Phosphorylation → internalisation → recyclage | **Disjoncteur à quatre états** — dégradation graduelle (DESENSITIZED) avant blocage complet (OPEN), avec courbe de récupération exponentielle | Bhalla & Bhatt (2007) *BMC Syst Biol* 1:54 |
| Dégradation de l'AMPc | Dégradation par phosphodiestérase | **Notifications à décroissance de signal** — le score d'importance décroît exponentiellement ; abandon de la relance sous le seuil | Alon (2007) *Intro to Systems Biology* Ch.4 |
| Quorum sensing | Seuil de concentration d'auto-inducteur | **Découverte sensible à la densité** — sondage adaptatif avec hystérésis (mode explore ↔ stable) basé sur la population de pairs | Tamsir *et al.* (2011) *Nature* 469:212 |
| Sélection de voie de signalisation | Efficacité × vitesse de transduction | **Transport adaptatif** — scoring par transport selon le taux de succès × facteur de latence ; les transports non testés ont la priorité d'exploration | Kholodenko (2006) *Nat Rev Mol Cell Biol* 7:165 |
| Saturation enzymatique | Cinétique de Michaelis-Menten | **Limitation douce de la concurrence** — délai progressif `baseDelay × load/(Km + load)` avant le mur dur de la file d'attente | Michaelis & Menten (1913) *Biochem Z* 49:333 |

### Quand activer

Toutes les fonctionnalités bio-inspirées sont **optionnelles et rétrocompatibles** — sans configuration explicite, la passerelle se comporte de manière identique aux implémentations standard. Activez-les lorsque votre déploiement dépasse les valeurs par défaut :

| Fonctionnalité | Activer quand... | Clé de configuration |
|----------------|-----------------|---------------------|
| Routage par affinité Hill | 5+ pairs avec des compétences qui se chevauchent | `routing.affinity` |
| Disjoncteur à quatre états | Les pairs ont des pannes intermittentes | `resilience.circuitBreaker.softThreshold` |
| Relance à décroissance de signal | Les endpoints webhook sont instables | Activé par défaut |
| Découverte par quorum sensing | Réseau de pairs dynamique avec DNS-SD | `discovery.quorum` |
| Transport adaptatif | Les pairs exposent plusieurs transports | Automatique (apprend de l'utilisation) |
| Concurrence douce MM | Opérations haute fréquence sub-seconde | `limits.saturation` |

> Benchmark: `npm run benchmark`

## Historique des versions

| Version | Points marquants |
|---------|-----------------|
| **v1.2.0** | Routage par compétences des pairs, auto-annonce mDNS (découverte symétrique) |
| **v1.1.0** | Extraction d'URL, basculement de transport, notifications push, routage par règles, découverte DNS-SD |
| **v1.0.1** | Identité de périphérique Ed25519, authentification des métriques, CI |
| **v1.0.0** | Prêt pour la production : persistance, multi-tours, transfert de fichiers, SSE, contrôles de santé, multi-jetons, audit |
| **v0.1.0** | Implémentation initiale A2A v0.3.0 |

Voir [CHANGELOG.md](CHANGELOG.md) pour les détails complets et [Releases](https://github.com/win4r/openclaw-a2a-gateway/releases) pour les téléchargements.

## Licence

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
