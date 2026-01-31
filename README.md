# telegram-userbot

🎙️ **Telegram Userbot Plugin for Clawdbot**

Text and voice conversations with your Clawdbot assistant through Telegram userbot - 100% local STT/TTS!

## ✨ Features

- 💬 **Text messaging** - Chat with your assistant via Telegram
- 🎤 **Voice notes (input)** - Send voice notes, automatically transcribed with faster-whisper
- 🔊 **Voice notes (output)** - Receive voice responses generated with Piper TTS
- 🌍 **Auto language detection** - Single-pass detection during transcription
- 🔄 **Language persistence** - Detected language used for TTS response
- 🧹 **Markdown stripping** - Clean text for natural TTS output
- 🏷️ **Audio metadata** - Voice notes show bot name instead of "Unknown Track"
- 🧠 **Full Clawdbot integration** - Personality, memory, tools

## ⚠️ Userbot vs Bot

This plugin uses a **Telegram userbot** (MTProto API), NOT a BotFather bot:

| BotFather Bot | Userbot (this plugin) |
|---------------|----------------------|
| Bot API | MTProto API (Pyrogram) |
| Cannot make calls | Can make voice calls (future) |
| Limited features | Full user access |
| grammY/Telegraf | Pyrogram |

## 🎤 Voice-to-Voice Mode

When your voice note starts with the bot's name (default: "Jarvis"), you get a voice response:

```
You: 🎤 "Jarvis, what's the weather like?"
Bot: 🔊 [Voice note response in your detected language]
```

**Variant detection:** Whisper may transcribe "Jarvis" differently depending on the language context. The plugin automatically recognizes common variants:
- `jarvis`, `xervis` (Catalan), `charvis` (Spanish J), `yarvis`, `gervis`, `jarbis`

When your voice note doesn't start with the bot name, you get transcription + translation:

```
You: 🎤 "Estamos trabajando en el proyecto..."
Bot: 📝 Transcripció: "Estamos trabajando en el proyecto..."
```

**TTS cleanup:** Voice responses automatically strip markdown formatting, emojis, and special characters for natural-sounding audio. A small audio padding is added to prevent cutoff at the end.

## 📋 Requirements

- Clawdbot >= 2026.1.0
- **Python 3.10** (required for tgcalls compatibility)
- Python packages:
  - Pyrogram (Telegram MTProto)
  - faster-whisper (STT)
  - tgcalls + pytgcalls (P2P voice calls - prepared for future use)
- [Piper TTS](https://github.com/rhasspy/piper) binary + voice models
- ffmpeg with libopus (for OGG conversion)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

## 🚀 Installation

### 1. Clone and build the plugin

```bash
git clone https://github.com/silverbacking/clawdbot-telegram-userbot
cd clawdbot-telegram-userbot
npm install
npm run build
```

### 2. Link to Clawdbot

```bash
mkdir -p ~/.clawdbot/extensions
ln -s $(pwd) ~/.clawdbot/extensions/telegram-userbot
```

### 3. Set up Python environment

```bash
mkdir -p ~/.clawdbot/telegram-userbot
python3 -m venv ~/.clawdbot/telegram-userbot/venv
source ~/.clawdbot/telegram-userbot/venv/bin/activate

# Core dependencies
pip install pyrogram tgcrypto

# Voice service dependencies
pip install faster-whisper
```

### 4. Install Piper TTS

```bash
# Download Piper binary
mkdir -p ~/piper
cd ~/piper
wget https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz
tar -xzf piper_amd64.tar.gz

# Download voice models
mkdir -p ~/piper/voices
cd ~/piper/voices

# English
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# Spanish
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json

# Catalan
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx.json
```

### 5. Set up the Voice Service

Copy the voice service files to your Clawdbot directory:

```bash
cp telegram-voice-service.py ~/.clawdbot/telegram-userbot/
cp telegram-voice-cli.py ~/.clawdbot/telegram-userbot/
```

Start the voice service:

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python3 telegram-voice-service.py &
```

Test it:

```bash
python3 telegram-voice-cli.py status
```

### 6. Create Telegram session

Get your API credentials from [my.telegram.org](https://my.telegram.org):
1. Log in with your phone number
2. Go to "API development tools"
3. Create a new application
4. Note your `api_id` and `api_hash`

Create the session:

```bash
source ~/.clawdbot/telegram-userbot/venv/bin/activate
python3 << 'EOF'
from pyrogram import Client

app = Client(
    "session",
    api_id=YOUR_API_ID,
    api_hash="YOUR_API_HASH",
    workdir="~/.clawdbot/telegram-userbot"
)
app.run()
EOF
```

Enter your phone number and the verification code when prompted.

## ⚙️ Configuration

Add to your `~/.clawdbot/clawdbot.json`:

```json
{
  "channels": {
    "telegram-userbot": {
      "enabled": true,
      "apiId": 12345678,
      "apiHash": "your_api_hash_here",
      "phone": "+1234567890",
      "sessionPath": "~/.clawdbot/telegram-userbot/session",
      "pythonEnvPath": "~/.clawdbot/telegram-userbot/venv",
      "allowedUsers": [123456789],
      "stt": {
        "provider": "faster-whisper",
        "language": "auto"
      },
      "tts": {
        "provider": "piper",
        "piperPath": "~/piper/piper/piper",
        "voicePath": "~/piper/voices/en_US-lessac-medium.onnx",
        "lengthScale": 0.85
      }
    }
  },
  "plugins": {
    "load": {
      "paths": ["~/.clawdbot/extensions/telegram-userbot"]
    },
    "entries": {
      "telegram-userbot": {
        "enabled": true
      }
    }
  }
}
```

### Finding your Telegram user ID

The `allowedUsers` array should contain the Telegram user IDs that are allowed to interact with the bot. To find your user ID:

```bash
source ~/.clawdbot/telegram-userbot/venv/bin/activate
python3 << 'EOF'
from pyrogram import Client

async def main():
    app = Client("session", workdir="~/.clawdbot/telegram-userbot")
    await app.start()
    me = await app.get_me()
    print(f"Your user ID: {me.id}")
    await app.stop()

import asyncio
asyncio.run(main())
EOF
```

### Path expansion

All paths support `~` and `$HOME` expansion.

## 🎤 Voice Service

The plugin uses a separate voice service (`telegram-voice-service.py`) that handles:

- **STT (Speech-to-Text)**: faster-whisper with automatic language detection
- **TTS (Text-to-Speech)**: Piper with multi-language support
- **Language management**: Per-user language preferences

### Voice Service CLI

Test the voice service with the included CLI:

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate

# Check status
python3 telegram-voice-cli.py status

# Transcribe audio
python3 telegram-voice-cli.py transcribe audio.ogg

# Synthesize speech
python3 telegram-voice-cli.py synthesize "Hello world" --lang en

# Manage user language
python3 telegram-voice-cli.py language get 123456789
python3 telegram-voice-cli.py language set 123456789 ca
```

### Voice Service as systemd service (recommended)

Create `~/.config/systemd/user/telegram-voice-service.service`:

```ini
[Unit]
Description=Telegram Voice Service
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.clawdbot/telegram-userbot
Environment="PATH=%h/.clawdbot/telegram-userbot/venv/bin:/usr/bin"
Environment="LD_LIBRARY_PATH=%h/piper/piper"
ExecStart=%h/.clawdbot/telegram-userbot/venv/bin/python3 telegram-voice-service.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable telegram-voice-service
systemctl --user start telegram-voice-service
```

## 🌍 Supported Languages

| Language | Code | Whisper | Piper Voice |
|----------|------|---------|-------------|
| English | `en` | ✅ | `en_US-lessac-medium` |
| Spanish | `es` | ✅ | `es_ES-sharvard-medium` |
| Catalan | `ca` | ✅ | `ca_ES-upc_pau-x_low` |

Add more languages by:
1. Downloading a Piper voice model
2. Adding the language to `SUPPORTED_LANGUAGES` in `telegram-voice-service.py`

## 📊 Performance

Benchmarks on Intel i7-10610U (CPU):

| Operation | Time |
|-----------|------|
| STT (5s audio) | ~3.5s |
| TTS (short sentence) | ~200ms |
| WAV→OGG conversion | ~85ms |
| **Total voice-to-voice** | **~4-5s** |

### Optimizations

- **Single-pass STT**: Language detection happens during transcription, not as a separate step
- **OGG output**: 3x smaller files, faster upload to Telegram
- **Preloaded models**: Whisper models stay in memory for instant processing

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Telegram App                            │
│               (Text / Voice Notes)                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ MTProto
                          ▼
┌─────────────────────────────────────────────────────────────┐
│           telegram-text-bridge.py (Pyrogram)                │
│                 JSON-RPC over stdin/stdout                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              telegram-userbot (Node.js plugin)              │
│  ┌────────────────────┐    ┌─────────────────────────────┐  │
│  │     Monitor        │    │      Voice Client           │  │
│  │  (message routing) │    │  (JSON-RPC to voice svc)    │  │
│  └─────────┬──────────┘    └──────────────┬──────────────┘  │
│            │                              │                 │
│            ▼                              ▼                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │            telegram-voice-service.py                   │ │
│  │  ┌─────────────────┐    ┌─────────────────────────┐    │ │
│  │  │  faster-whisper │    │      Piper TTS          │    │ │
│  │  │  (Local STT)    │    │    (Local TTS)          │    │ │
│  │  │  • small model  │    │  • Multi-language       │    │ │
│  │  │  • auto-detect  │    │  • OGG output           │    │ │
│  │  └─────────────────┘    └─────────────────────────┘    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Clawdbot Core                            │
│            Claude API + Personality + Memory + Tools        │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Troubleshooting

### Voice service not responding

```bash
# Check if running
pgrep -f telegram-voice-service

# Check socket
ls -la /run/user/$(id -u)/telegram-voice.sock

# Test connection
python3 telegram-voice-cli.py status
```

### "Database is locked" error

The Pyrogram session SQLite database is locked by another process:

```bash
# Kill orphaned bridge processes
pkill -f telegram-text-bridge.py
```

### Voice notes not transcribing

1. Check faster-whisper is installed: `pip show faster-whisper`
2. Check voice service logs
3. Ensure the audio file exists in the temp directory

### TTS not working

1. Check Piper binary: `~/piper/piper/piper --help`
2. Check voice model exists: `ls ~/piper/voices/`
3. Check LD_LIBRARY_PATH includes Piper directory

## 🚀 Setting a Username

To make your userbot easily accessible via `t.me/YourBotName`:

```bash
source ~/.clawdbot/telegram-userbot/venv/bin/activate
python3 << 'EOF'
from pyrogram import Client
import asyncio

async def set_username():
    app = Client("session", workdir="~/.clawdbot/telegram-userbot")
    await app.start()
    await app.set_username("YourDesiredUsername")
    me = await app.get_me()
    print(f"Username set: @{me.username}")
    await app.stop()

asyncio.run(set_username())
EOF
```

## 📱 iPhone Shortcut

Create a quick access shortcut on iOS:

1. Open **Shortcuts** app
2. Create new shortcut → **Open URLs**
3. URL: `tg://resolve?domain=YourBotUsername`
4. Save and add to Home Screen

## 📊 Status

- ✅ Text messaging (send/receive)
- ✅ Voice notes (receive + transcribe)
- ✅ Voice notes (send with TTS)
- ✅ Language auto-detection (single-pass)
- ✅ Language persistence per user
- ✅ Markdown stripping for TTS
- ✅ OGG conversion with metadata
- ✅ Voice-to-voice mode ("Jarvis..." trigger)
- ⏳ Voice calls (future)

## 📜 License

MIT © [Carles Abarca](https://github.com/carlesabarca)
