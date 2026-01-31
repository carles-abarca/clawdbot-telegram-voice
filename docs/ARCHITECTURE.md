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
| Linux | Unix Domain Socket | `/run/user/{UID}/tts-stt.sock` |
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

## Trucades d'Àudio P2P: Disseny Tècnic

### Visió General

Les trucades P2P (peer-to-peer) permeten converses de veu en temps real entre l'usuari i l'assistent. A diferència de les notes de veu (fitxers d'àudio complets), les trucades requereixen streaming bidireccional continu.

```
┌─────────────────┐          WebRTC/MTProto           ┌─────────────────┐
│                 │◄────────────────────────────────►│                 │
│  Usuari (App    │         Àudio en temps real       │  telegram-voice │
│  Telegram)      │                                   │  -service       │
│                 │                                   │  (Python 3.10)  │
└─────────────────┘                                   └────────┬────────┘
                                                               │
                                                               │ Chunks d'àudio
                                                               ▼
                                                      ┌─────────────────┐
                                                      │  Pipeline de    │
                                                      │  Processament   │
                                                      │  ┌───────────┐  │
                                                      │  │  Whisper  │  │
                                                      │  │  (STT)    │  │
                                                      │  └─────┬─────┘  │
                                                      │        │        │
                                                      │        ▼        │
                                                      │  ┌───────────┐  │
                                                      │  │  Claude   │  │
                                                      │  │  (LLM)    │  │
                                                      │  └─────┬─────┘  │
                                                      │        │        │
                                                      │        ▼        │
                                                      │  ┌───────────┐  │
                                                      │  │  Piper    │  │
                                                      │  │  (TTS)    │  │
                                                      │  └───────────┘  │
                                                      └─────────────────┘
```

### Components Clau

#### 1. tgcalls (C++ WebRTC Binding)
- **Paquet:** `tgcalls` (PyPI, wheels per Python 3.10)
- **Funció:** Gestiona la capa WebRTC per a l'àudio
- **Classe principal:** `NativeInstance`

#### 2. pytgcalls (SDK Python)
- **Font:** Repository MarshalX/tgcalls
- **Funció:** API d'alt nivell per trucades Telegram
- **Classes clau:**
  - `GroupCallFactory` - per trucades de grup
  - `Tgcalls`, `IncomingCall`, `OutgoingCall` - per trucades privades P2P

#### 3. Pyrogram (MTProto Client)
- **Funció:** Autenticació i senyalització de trucades
- **Events:** `on_raw_update` per detectar trucades entrants

### Flux de Trucada Entrant

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        FASE 1: DETECCIÓ                                  │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
    Telegram envia UpdatePhoneCall │
                                   ▼
                    ┌──────────────────────────┐
                    │  Pyrogram raw_update     │
                    │  handler detecta trucada │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  Crear IncomingCall amb  │
                    │  phone_call object       │
                    └────────────┬─────────────┘
                                 │
┌──────────────────────────────────────────────────────────────────────────┐
│                        FASE 2: ACCEPTACIÓ                                │
└──────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  incoming_call.accept()  │
                    │  - Genera claus DH       │
                    │  - Envia AcceptCall      │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  WebRTC handshake        │
                    │  - ICE candidates        │
                    │  - SRTP setup            │
                    └────────────┬─────────────┘
                                 │
┌──────────────────────────────────────────────────────────────────────────┐
│                        FASE 3: STREAMING                                 │
└──────────────────────────────────────────────────────────────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│  ÀUDIO ENTRANT           │          │  ÀUDIO SORTINT           │
│                          │          │                          │
│  WebRTC → PCM chunks     │          │  WAV file → WebRTC       │
│       │                  │          │       ▲                  │
│       ▼                  │          │       │                  │
│  Acumular en buffer      │          │  Piper genera WAV        │
│       │                  │          │       ▲                  │
│       ▼                  │          │       │                  │
│  Detectar silenci        │          │  Claude respon           │
│  (VAD - Voice Activity)  │          │       ▲                  │
│       │                  │          │       │                  │
│       ▼                  │          │  Whisper transcriu       │
│  Guardar segment WAV     │──────────│       ▲                  │
│                          │          │       │                  │
└──────────────────────────┘          └───────┴──────────────────┘
```

### Gestió d'Àudio en Temps Real

#### Captura d'Àudio Entrant

```python
class CallAudioHandler:
    def __init__(self):
        self.audio_buffer = io.BytesIO()
        self.sample_rate = 48000  # Telegram usa 48kHz
        self.channels = 1         # Mono
        self.chunk_duration = 0.02  # 20ms per chunk
        self.silence_threshold = 500  # Amplitud mínima
        self.silence_duration = 0  # Segons de silenci
        self.max_silence = 1.5    # Segons abans de processar
        
    def on_audio_frame(self, frame: bytes):
        """Cridat per cada chunk d'àudio rebut (cada 20ms)"""
        # Detectar si és silenci
        amplitude = self._get_amplitude(frame)
        
        if amplitude < self.silence_threshold:
            self.silence_duration += self.chunk_duration
        else:
            self.silence_duration = 0
            
        # Acumular àudio
        self.audio_buffer.write(frame)
        
        # Si detectem pausa llarga, processar
        if self.silence_duration >= self.max_silence and self.audio_buffer.tell() > 0:
            self._process_utterance()
            
    def _process_utterance(self):
        """Processa un segment de parla complet"""
        # Obtenir àudio acumulat
        audio_data = self.audio_buffer.getvalue()
        self.audio_buffer = io.BytesIO()  # Reset buffer
        
        # Guardar com WAV temporal
        wav_path = f"/tmp/call_input_{time.time()}.wav"
        self._save_as_wav(audio_data, wav_path)
        
        # Processar: STT → LLM → TTS
        asyncio.create_task(self._generate_response(wav_path))
```

#### Generació de Resposta

```python
async def _generate_response(self, input_wav: str):
    """Pipeline complet: STT → Claude → TTS → Enviar"""
    
    # 1. Transcripció (Whisper)
    text = await self.whisper.transcribe(input_wav)
    if not text.strip():
        return  # Ignorar si no hi ha text
        
    logger.info(f"Usuari diu: {text}")
    
    # 2. Obtenir resposta de Claude
    response = await self.claude.generate(
        text,
        system="Estàs en una trucada de veu. Respon de forma natural i concisa."
    )
    logger.info(f"Claude respon: {response}")
    
    # 3. Generar àudio (Piper)
    output_wav = f"/tmp/call_output_{time.time()}.wav"
    await self.piper.synthesize(response, output_wav)
    
    # 4. Enviar àudio a la trucada
    await self.send_audio_to_call(output_wav)
```

#### Enviament d'Àudio a la Trucada

```python
async def send_audio_to_call(self, wav_path: str):
    """Envia un fitxer WAV com a stream d'àudio"""
    
    # Carregar WAV i convertir a format correcte
    audio = AudioSegment.from_wav(wav_path)
    audio = audio.set_frame_rate(48000)  # Telegram requereix 48kHz
    audio = audio.set_channels(1)         # Mono
    
    # Obtenir PCM raw
    pcm_data = audio.raw_data
    
    # Enviar en chunks de 20ms
    chunk_size = 48000 * 2 * 0.02  # 48kHz * 16bit * 20ms = 1920 bytes
    
    for i in range(0, len(pcm_data), int(chunk_size)):
        chunk = pcm_data[i:i + int(chunk_size)]
        
        # Padding si l'últim chunk és massa curt
        if len(chunk) < chunk_size:
            chunk += b'\x00' * (int(chunk_size) - len(chunk))
            
        # Enviar via WebRTC
        self.native_instance.send_audio_frame(chunk)
        
        # Esperar el temps real del chunk
        await asyncio.sleep(0.02)
```

### Integració amb el Servei de Veu Existent

El servei `telegram-voice-service.py` actual gestiona notes de veu. Afegirem mòduls per trucades:

```
telegram-voice-service.py
├── VoiceService (existent)
│   ├── transcribe()      # STT per notes de veu
│   └── synthesize()      # TTS per notes de veu
│
└── CallService (NOU)
    ├── handle_incoming() # Acceptar trucada entrant
    ├── handle_outgoing() # Iniciar trucada sortint
    ├── audio_pipeline    # Processament en temps real
    └── CallAudioHandler  # Captura i enviament d'àudio
```

### Nous Mètodes JSON-RPC per Trucades

```python
# Mètodes del servei
CALL_METHODS = {
    # Gestió de trucades
    "call.accept": handle_accept,      # Acceptar trucada entrant
    "call.reject": handle_reject,      # Rebutjar trucada
    "call.hangup": handle_hangup,      # Penjar trucada activa
    "call.start": handle_start,        # Iniciar trucada sortint
    
    # Estat
    "call.status": handle_call_status, # Estat de la trucada activa
    "call.active": handle_active,      # Hi ha trucada activa?
}

# Events emesos pel servei
CALL_EVENTS = [
    "call.incoming",    # Trucada entrant detectada
    "call.connected",   # Trucada connectada
    "call.ended",       # Trucada finalitzada
    "call.audio_chunk", # Chunk d'àudio rebut (opcional)
    "call.transcription", # Text transcrit
    "call.response",    # Resposta generada
]
```

### Configuració Addicional

```json
// ~/.clawdbot/clawdbot.json
{
  "channels": {
    "telegram-userbot": {
      "calls": {
        "enabled": true,
        "autoAnswer": true,           // Contestar automàticament
        "autoAnswerDelay": 1000,      // ms abans de contestar
        "maxCallDuration": 300,       // Màxim 5 minuts
        "silenceTimeout": 1.5,        // Segons de silenci per processar
        "greeting": "Hola, sóc Jarvis. En què et puc ajudar?",
        "goodbye": "D'acord, fins aviat!"
      }
    }
  }
}
```

### Consideracions de Rendiment

| Operació | Temps estimat | Notes |
|----------|---------------|-------|
| Detecció silenci | <1ms | En temps real per cada chunk |
| Whisper STT | 1-3s | Depèn de la durada del segment |
| Claude API | 1-5s | Depèn de la complexitat |
| Piper TTS | 0.1-0.5s | Molt ràpid localment |
| **Total latència** | **2-9s** | Entre que l'usuari acaba i rep resposta |

### Millores Futures

1. **Streaming STT:** Usar Whisper en mode streaming per reduir latència
2. **Interrupció:** Detectar quan l'usuari interromp i aturar la resposta
3. **VAD millorat:** Usar WebRTC VAD o Silero VAD per millor detecció
4. **Caché de respostes:** Respostes freqüents pre-generades
5. **Múltiples trucades:** Suport per trucades en cua

---

## Pròxims Passos d'Implementació

### Fase 1: Infraestructura (2h)
- [ ] Afegir handler de trucades entrants a `telegram-voice-service.py`
- [ ] Implementar `IncomingCall` amb acceptació automàtica
- [ ] Crear buffer d'àudio i detecció de silenci

### Fase 2: Pipeline d'Àudio (2h)
- [ ] Captura d'àudio entrant en temps real
- [ ] Integració amb Whisper existent
- [ ] Enviament d'àudio generat per Piper

### Fase 3: Integració Clawdbot (1h)
- [ ] Nous mètodes JSON-RPC per trucades
- [ ] Events de trucada al plugin Node.js
- [ ] Configuració de trucades

### Fase 4: Testing i Polish (1h)
- [ ] Tests amb trucades reals
- [ ] Ajustar timeouts i thresholds
- [ ] Documentació d'usuari

---

*Document actualitzat: 2026-01-30*
*Autor: Jarvis*
