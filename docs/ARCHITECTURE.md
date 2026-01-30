# Arquitectura: Telegram Userbot + Voice Service

## Visió General

El sistema es divideix en **dos components separats** per garantir estabilitat i resiliència:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Clawdbot Gateway                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  telegram-userbot plugin (Node.js)                            │  │
│  │  - Lleuger (~50MB RAM)                                        │  │
│  │  - Pyrogram per missatges de text                             │  │
│  │  - Client JSON-RPC per trucades                               │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ Unix Socket (Linux)
                              │ TCP localhost (Mac)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  telegram-voice-service (Python, procés independent)               │
│  - Pesat durant trucades (~500MB+ RAM)                             │
│  - Pyrogram + PyTgCalls + NTgCalls                                 │
│  - Només s'activa quan hi ha trucada                               │
│  - Gestionat per systemd (Linux) o launchd (Mac)                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Plugin `telegram-userbot` (Node.js/TypeScript)

**Responsabilitats:**
- Gestionar missatges de text entrants/sortints
- Gestionar notes de veu (STT/TTS)
- Comunicar-se amb el servei de veu per trucades
- Injectar missatges a Clawdbot

**NO fa:**
- Cap càrrega de PyTgCalls/NTgCalls
- Cap streaming d'àudio directe

**Dependències:**
- Node.js (ja inclòs amb Clawdbot)
- Python + Pyrogram (per missatges)

### 2. Servei `telegram-voice-service` (Python)

**Responsabilitats:**
- Gestionar trucades de veu (iniciar, acabar, streaming)
- Exposar API JSON-RPC per rebre comandes
- Enviar events al plugin (trucada entrant, trucada acabada)

**Dependències:**
- Python 3.10+
- Pyrogram/Pyrofork
- PyTgCalls + NTgCalls
- Sessió de Telegram separada

---

## Protocol de Comunicació: JSON-RPC 2.0

### Transport

| Plataforma | Transport | Path/Port |
|------------|-----------|-----------|
| Linux | Unix Domain Socket | `/run/user/{UID}/telegram-voice.sock` |
| macOS | TCP localhost | `127.0.0.1:18790` |

**Nota:** macOS no suporta Unix sockets tan bé com Linux per a serveis, per això usem TCP localhost.

### Format de Missatges

**Request (Plugin → Servei):**
```json
{
  "jsonrpc": "2.0",
  "method": "call.start",
  "params": {
    "user_id": 32975149,
    "audio_path": "/tmp/greeting.wav"
  },
  "id": 1
}
```

**Response (Servei → Plugin):**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "status": "ringing",
    "call_id": "abc123"
  },
  "id": 1
}
```

**Error:**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "User not available"
  },
  "id": 1
}
```

**Event/Notification (Servei → Plugin, sense id):**
```json
{
  "jsonrpc": "2.0",
  "method": "event.call_ended",
  "params": {
    "call_id": "abc123",
    "duration_seconds": 120,
    "reason": "hangup"
  }
}
```

### Mètodes Disponibles

#### Comandes (Plugin → Servei)

| Mètode | Params | Descripció |
|--------|--------|------------|
| `call.start` | `{user_id, audio_path?}` | Iniciar trucada amb usuari |
| `call.end` | `{call_id?}` | Acabar trucada actual |
| `call.send_audio` | `{call_id, audio_path}` | Enviar àudio durant trucada |
| `call.mute` | `{call_id, muted}` | Silenciar/activar micro |
| `status.get` | `{}` | Obtenir estat del servei |
| `status.health` | `{}` | Health check |

#### Events (Servei → Plugin)

| Event | Params | Descripció |
|-------|--------|------------|
| `event.call_incoming` | `{user_id, user_name}` | Trucada entrant |
| `event.call_started` | `{call_id, user_id}` | Trucada connectada |
| `event.call_ended` | `{call_id, duration, reason}` | Trucada acabada |
| `event.audio_received` | `{call_id, audio_path}` | Àudio rebut de l'usuari |
| `event.error` | `{code, message}` | Error del servei |

---

## Instal·lació Multiplataforma

### Estructura del Plugin

```
clawdbot-telegram-userbot/
├── package.json              # Plugin Node.js
├── clawdbot.plugin.json      # Manifest Clawdbot
├── src/
│   ├── index.ts              # Entry point plugin
│   ├── config.ts             # Configuració
│   ├── message-bridge.ts     # Pyrogram per missatges (subprocess)
│   ├── voice-client.ts       # Client JSON-RPC per trucades
│   └── stt.ts, tts.ts        # Speech processing
├── scripts/
│   ├── install.sh            # Instal·lador multiplataforma
│   ├── install-linux.sh      # Específic Linux
│   ├── install-macos.sh      # Específic macOS
│   └── uninstall.sh          # Desinstal·lador
├── service/
│   ├── telegram-voice-service.py   # Servei Python
│   ├── requirements.txt            # Dependències Python
│   ├── systemd/
│   │   └── telegram-voice.service  # Unit file Linux
│   └── launchd/
│       └── com.clawdbot.telegram-voice.plist  # macOS
└── docs/
    ├── ARCHITECTURE.md       # Aquest document
    └── INSTALL.md            # Guia instal·lació
```

### Script d'Instal·lació (`scripts/install.sh`)

```bash
#!/bin/bash
set -e

# Detectar plataforma
OS="$(uname -s)"
case "$OS" in
    Linux*)  ./scripts/install-linux.sh ;;
    Darwin*) ./scripts/install-macos.sh ;;
    *)       echo "Plataforma no suportada: $OS"; exit 1 ;;
esac
```

### Instal·lació Linux (`scripts/install-linux.sh`)

```bash
#!/bin/bash
set -e

INSTALL_DIR="$HOME/.clawdbot/telegram-userbot"
VENV_DIR="$INSTALL_DIR/venv"
SERVICE_NAME="telegram-voice"

echo "📦 Instal·lant telegram-userbot per Linux..."

# 1. Crear directori
mkdir -p "$INSTALL_DIR"

# 2. Crear entorn virtual Python
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

# 3. Instal·lar dependències Python
pip install --upgrade pip
pip install pyrofork tgcrypto pytgcalls fastapi uvicorn

# 4. Copiar servei
cp service/telegram-voice-service.py "$INSTALL_DIR/"

# 5. Instal·lar systemd service (user mode)
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$SERVICE_NAME.service" << EOF
[Unit]
Description=Telegram Voice Service for Clawdbot
After=network.target

[Service]
Type=simple
ExecStart=$VENV_DIR/bin/python $INSTALL_DIR/telegram-voice-service.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

# Límits de recursos
MemoryMax=1G
MemoryHigh=800M
CPUQuota=50%

[Install]
WantedBy=default.target
EOF

# 6. Activar servei
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

echo "✅ Instal·lació completada!"
echo "   Per iniciar: systemctl --user start $SERVICE_NAME"
```

### Instal·lació macOS (`scripts/install-macos.sh`)

```bash
#!/bin/bash
set -e

INSTALL_DIR="$HOME/.clawdbot/telegram-userbot"
VENV_DIR="$INSTALL_DIR/venv"
PLIST_NAME="com.clawdbot.telegram-voice"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "📦 Instal·lant telegram-userbot per macOS..."

# 1. Crear directori
mkdir -p "$INSTALL_DIR"

# 2. Crear entorn virtual Python
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

# 3. Instal·lar dependències Python
pip install --upgrade pip
pip install pyrofork tgcrypto pytgcalls fastapi uvicorn

# 4. Copiar servei
cp service/telegram-voice-service.py "$INSTALL_DIR/"

# 5. Instal·lar launchd service
mkdir -p "$LAUNCH_AGENTS"
cat > "$LAUNCH_AGENTS/$PLIST_NAME.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV_DIR/bin/python</string>
        <string>$INSTALL_DIR/telegram-voice-service.py</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/logs/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
    </dict>
</dict>
</plist>
EOF

# 6. Carregar servei
launchctl load "$LAUNCH_AGENTS/$PLIST_NAME.plist"

echo "✅ Instal·lació completada!"
echo "   Per iniciar: launchctl start $PLIST_NAME"
```

---

## Sessions de Telegram

El sistema usa **dues sessions separades** del mateix compte:

| Sessió | Fitxer | Ús |
|--------|--------|-----|
| Principal | `session.session` | Missatges (plugin) |
| Veu | `session_voice.session` | Trucades (servei) |

### Primera configuració

```bash
# 1. Configurar sessió de missatges (ja existent)
clawdbot plugins configure telegram-userbot

# 2. Configurar sessió de veu (nova)
telegram-voice-service --setup
# Demana codi de verificació de Telegram
```

**Nota:** Telegram permet múltiples sessions del mateix compte. Això és similar a tenir l'app oberta al mòbil i a l'ordinador alhora.

---

## Gestió del Servei

### Linux (systemd)

```bash
# Estat
systemctl --user status telegram-voice

# Iniciar/aturar
systemctl --user start telegram-voice
systemctl --user stop telegram-voice

# Logs
journalctl --user -u telegram-voice -f

# Reiniciar
systemctl --user restart telegram-voice
```

### macOS (launchd)

```bash
# Iniciar
launchctl start com.clawdbot.telegram-voice

# Aturar
launchctl stop com.clawdbot.telegram-voice

# Logs
tail -f ~/.clawdbot/telegram-userbot/logs/stdout.log

# Reload config
launchctl unload ~/Library/LaunchAgents/com.clawdbot.telegram-voice.plist
launchctl load ~/Library/LaunchAgents/com.clawdbot.telegram-voice.plist
```

---

## Flux de Dades

### Missatge de Text Entrant

```
Telegram API
    │
    ▼
[Plugin] Pyrogram subprocess
    │
    ▼
[Plugin] message-bridge.ts
    │
    ▼
Clawdbot injectMessage()
    │
    ▼
Agent processa i respon
    │
    ▼
[Plugin] Envia resposta via Pyrogram
```

### Trucada de Veu

```
Carles: "Jarvis, truca'm"
    │
    ▼
Agent decideix trucar
    │
    ▼
[Plugin] voice-client.ts → JSON-RPC call.start
    │
    ▼ (Unix socket / TCP)
    │
[Servei] telegram-voice-service.py
    │
    ▼
PyTgCalls inicia trucada
    │
    ◄─────────────────────────────┐
    │                             │
[Servei] event.call_started ──────┘
    │
    ▼
Streaming d'àudio bidireccional
    │
    ▼
Trucada acaba
    │
    ▼
[Servei] event.call_ended → Plugin
```

---

## Consideracions de Seguretat

1. **Unix Socket:** Permisos 0600, només l'usuari pot accedir
2. **TCP localhost:** Només escolta a 127.0.0.1, no accessible externament
3. **Sessions Telegram:** Guardades a `~/.clawdbot/telegram-userbot/`, permisos 0700
4. **API Keys:** Mai al codi, sempre a config

---

## Pròxims Passos

1. [ ] Crear `service/telegram-voice-service.py` amb FastAPI + JSON-RPC
2. [ ] Modificar plugin per separar missatges de trucades
3. [ ] Crear `voice-client.ts` per comunicació JSON-RPC
4. [ ] Crear scripts d'instal·lació
5. [ ] Testing a Linux
6. [ ] Testing a macOS
7. [ ] Documentació usuari final

---

*Document creat: 2026-01-30*
*Autor: Jarvis*
