# Telegram VoiceChat Streaming Service

Servei de streaming d'àudio bidireccional per a Telegram Voice Chats i trucades P2P.

## Característiques

- **Streaming bidireccional**: Envia i rep àudio en temps real
- **STT (Speech-to-Text)**: Transcriu àudio dels participants amb whisper.cpp
- **TTS (Text-to-Speech)**: Genera veu amb Piper
- **Voice Chats**: Suport per a voice chats de grups i canals
- **Trucades P2P**: Suport per a trucades privades
- **Auto-answer**: Pot contestar trucades automàticament
- **Detecció de silenci**: Detecta quan l'usuari acaba de parlar

## Dependències

```bash
# Crear virtualenv
python3 -m venv ~/jarvis/dev/repos/tgcalls-env

# Activar i instal·lar
source ~/jarvis/dev/repos/tgcalls-env/bin/activate
pip install py-tgcalls hydrogram TgCrypto numpy
```

## Configuració

El servei llegeix la configuració de `~/.clawdbot/clawdbot.json`:

```json
{
  "channels": {
    "telegram-userbot": {
      "apiId": 123456,
      "apiHash": "abc123...",
      "stt": {
        "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
        "modelPath": "~/whisper.cpp/models/ggml-small.bin",
        "threads": 4
      },
      "tts": {
        "piperPath": "~/piper/piper/piper",
        "voicesDir": "~/piper/voices",
        "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
        "lengthScale": 0.7
      },
      "calls": {
        "autoAnswer": true,
        "autoAnswerDelay": 1000
      }
    }
  }
}
```

## Sessió de Telegram

⚠️ **Important**: Aquest servei utilitza una sessió separada (`session-voicechat.session`) per evitar conflictes amb altres serveis.

Per crear la sessió:
```bash
cp ~/.clawdbot/telegram-userbot/session.session ~/.clawdbot/telegram-userbot/session-voicechat.session
```

## Ús

### Executar manualment

```bash
source ~/jarvis/dev/repos/tgcalls-env/bin/activate
python telegram-voicechat-service.py
```

O amb el wrapper:
```bash
./run-voicechat.sh
```

### Systemd (user service)

```bash
# Copiar unit file
mkdir -p ~/.config/systemd/user/
cp telegram-voicechat.service ~/.config/systemd/user/telegram-voicechat@.service

# Habilitar i iniciar
systemctl --user enable telegram-voicechat@$USER
systemctl --user start telegram-voicechat@$USER

# Veure logs
journalctl --user -u telegram-voicechat@$USER -f
```

## API JSON-RPC

El servei exposa una API JSON-RPC via Unix Socket a:
`/run/user/$UID/telegram-voicechat.sock`

### Mètodes

#### `status`
Retorna l'estat del servei.

```json
{"jsonrpc": "2.0", "method": "status", "id": 1}
```

Resposta:
```json
{
  "service": "telegram-voicechat",
  "version": "1.0.0",
  "running": true,
  "active_sessions": [-1001234567890],
  "pyrogram": true,
  "pytgcalls": true
}
```

#### `join`
Uneix-se a un voice chat.

```json
{"jsonrpc": "2.0", "method": "join", "params": {"chat_id": -1001234567890}, "id": 1}
```

#### `leave`
Surt d'un voice chat.

```json
{"jsonrpc": "2.0", "method": "leave", "params": {"chat_id": -1001234567890}, "id": 1}
```

#### `speak`
Envia text com a veu al voice chat.

```json
{
  "jsonrpc": "2.0", 
  "method": "speak", 
  "params": {
    "chat_id": -1001234567890,
    "text": "Hola a tothom!",
    "language": "ca"
  }, 
  "id": 1
}
```

### Events (notificacions)

El servei envia notificacions als clients connectats:

- `call.incoming`: Trucada entrant
- `call.joined`: S'ha unit a un voice chat
- `call.left`: S'ha sortit d'un voice chat
- `transcription`: S'ha transcrit àudio d'un participant

## Test Client

```bash
# Status
python test-voicechat.py status

# Join voice chat
python test-voicechat.py join -1001234567890

# Speak
python test-voicechat.py speak -1001234567890 "Hola!" ca

# Leave
python test-voicechat.py leave -1001234567890
```

## Arquitectura

```
┌─────────────────────────────────────────────────┐
│           telegram-voicechat-service            │
├─────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │   Hydrogram  │    │       PyTgCalls       │  │
│  │   (MTProto)  │    │    (WebRTC + Voice)   │  │
│  └──────┬───────┘    └───────────┬───────────┘  │
│         │                        │              │
│  ┌──────┴────────────────────────┴───────┐      │
│  │           VoiceChatService            │      │
│  │  ┌───────────┐   ┌───────────┐        │      │
│  │  │ STT       │   │ TTS       │        │      │
│  │  │ (Whisper) │   │ (Piper)   │        │      │
│  │  └───────────┘   └───────────┘        │      │
│  └───────────────────────────────────────┘      │
│                      │                          │
│  ┌───────────────────┴────────────────────┐     │
│  │         JSON-RPC Server               │     │
│  │      (Unix Socket API)                │     │
│  └────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
        │
        ▼
   Clawdbot Gateway
```

## Flux de dades

### Incoming Audio (STT)
1. Participant parla al voice chat
2. PyTgCalls rep frames d'àudio (48kHz stereo PCM16)
3. AudioBuffer acumula frames amb detecció de silenci
4. Quan detecta pausa → enviar a Whisper per transcriure
5. Emetre event `transcription` amb el text

### Outgoing Audio (TTS)
1. Client envia `speak` amb text
2. Piper genera WAV
3. FFmpeg converteix a PCM16 48kHz stereo
4. Enviar frames via `send_frame()` a PyTgCalls
5. PyTgCalls transmet via WebRTC

## Idiomes suportats

- **ca** (Català): `ca_ES-upc_pau-x_low.onnx`
- **es** (Castellà): `es_ES-sharvard-medium.onnx`
- **en** (Anglès): `en_US-lessac-medium.onnx`

## Limitacions

- Només una sessió activa per chat
- La transcripció té un delay de ~1.5s (temps de silenci per detectar fi de frase)
- No suporta video (només àudio)
- Requereix una sessió de Telegram amb accés a l'API

## Troubleshooting

### "database is locked"
Un altre procés està utilitzant la mateixa sessió. Utilitza una sessió separada:
```bash
cp ~/.clawdbot/telegram-userbot/session.session ~/.clawdbot/telegram-userbot/session-voicechat.session
```

### "GroupcallForbidden"
Actualitza a Hydrogram en lloc de Pyrogram:
```bash
pip install hydrogram
```

### "Connection refused"
El servei no està corrent o el socket no s'ha creat correctament.
