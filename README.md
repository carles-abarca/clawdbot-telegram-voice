# Clawdbot Telegram Userbot Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Telegram userbot plugin for [Clawdbot](https://github.com/clawdbot/clawdbot) that enables:

- 📱 **Text & Media** - Send/receive messages, photos, videos, documents
- 🎤 **Voice Notes** - Speech-to-text (STT) and text-to-speech (TTS)
- 📞 **Voice Chats** - Real-time bidirectional audio streaming in group calls
- 🌐 **Multi-language** - Supports Catalan, Spanish, and English

## Why a Userbot?

Unlike bot accounts, a userbot uses your personal Telegram account, which means:
- ✅ No bot API limitations
- ✅ Access to all chats (not just where added)
- ✅ Voice calls and voice chats support
- ✅ Full message history access

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Clawdbot Gateway                             │
│                         (Node.js)                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ JSON IPC
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                telegram-text-bridge.py                          │
│                    (Pyrogram MTProto)                           │
│  • Text messages    • Media handling    • Voice note trigger    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Unix Socket
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│               telegram-voice-service.py                         │
│                    (STT + TTS Engine)                           │
│  • whisper.cpp (STT)    • Piper (TTS)    • Language detection   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│             telegram-voicechat-service.py (Optional)            │
│                (Hydrogram + py-tgcalls)                         │
│  • Voice chat streaming  • Real-time STT  • Live TTS responses  │
└─────────────────────────────────────────────────────────────────┘
```

## Requirements

### System
- Linux (Ubuntu 22.04+ recommended)
- Python 3.10+
- Node.js 18+ (for Clawdbot)
- ffmpeg

### STT Engine (choose one)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (recommended, local)
- OpenAI Whisper API

### TTS Engine (choose one)
- [Piper](https://github.com/rhasspy/piper) (recommended, local)
- ElevenLabs API
- OpenAI TTS API

## Installation

### Quick Install

```bash
git clone https://github.com/YOUR_USERNAME/clawdbot-telegram-userbot.git
cd clawdbot-telegram-userbot

# Install core (text + voice notes)
./install.sh --core

# Or install everything including voice chat streaming
./install.sh --all
```

### Manual Install

```bash
# Create installation directory
mkdir -p ~/.clawdbot/telegram-userbot
cd ~/.clawdbot/telegram-userbot

# Create virtual environment for core services
python3 -m venv venv
source venv/bin/activate
pip install pyrogram TgCrypto pydub aiofiles

# (Optional) Create separate venv for voice chat
python3 -m venv venv-voicechat
source venv-voicechat/bin/activate
pip install hydrogram TgCrypto py-tgcalls numpy
```

## Configuration

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
        "provider": "whisper-cpp",
        "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
        "modelPath": "~/whisper.cpp/models/ggml-small.bin",
        "language": "auto",
        "threads": 4
      },
      "tts": {
        "provider": "piper",
        "piperPath": "~/piper/piper/piper",
        "voicesDir": "~/piper/voices",
        "defaultVoice": "ca_ES-upc_pau-x_low.onnx",
        "lengthScale": 0.7
      }
    }
  }
}
```

### Getting API Credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Go to "API development tools"
4. Create a new application
5. Copy `api_id` and `api_hash`

### Creating a Session

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python3 << 'EOF'
from pyrogram import Client
app = Client("session", api_id=YOUR_API_ID, api_hash="YOUR_API_HASH")
app.run()
EOF
```

## Services

### telegram-voice.service

Handles STT and TTS for voice notes.

```bash
# Start
systemctl --user start telegram-voice

# Enable on boot
systemctl --user enable telegram-voice

# View logs
journalctl --user -u telegram-voice -f
```

### telegram-voicechat.service (Optional)

Handles real-time voice chat streaming.

```bash
# Start
systemctl --user start telegram-voicechat

# Enable on boot
systemctl --user enable telegram-voicechat
```

## Testing

```bash
# Quick test (skips STT, ~5 seconds)
~/.clawdbot/telegram-userbot/test-telegram-userbot.sh --quick

# Full test suite (~2-3 minutes)
~/.clawdbot/telegram-userbot/test-telegram-userbot.sh

# Verbose output
~/.clawdbot/telegram-userbot/test-telegram-userbot.sh --verbose
```

## Voice Models

### Piper TTS Voices

Download voices from [Piper Voices](https://github.com/rhasspy/piper/blob/master/VOICES.md):

| Language | Voice | File |
|----------|-------|------|
| Catalan | Pau (male) | `ca_ES-upc_pau-x_low.onnx` |
| Catalan | Ona (female) | `ca_ES-upc_ona-medium.onnx` |
| Spanish | Sharvard | `es_ES-sharvard-medium.onnx` |
| English | Lessac | `en_US-lessac-medium.onnx` |

### Whisper Models

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| tiny | 75MB | ⚡⚡⚡⚡ | ⭐ |
| base | 142MB | ⚡⚡⚡ | ⭐⭐ |
| small | 466MB | ⚡⚡ | ⭐⭐⭐ |
| medium | 1.5GB | ⚡ | ⭐⭐⭐⭐ |

## API Reference

### Voice Service (Unix Socket)

Socket path: `/run/user/$UID/tts-stt.sock`

#### Methods

| Method | Description |
|--------|-------------|
| `health` | Health check |
| `status` | Service status |
| `transcribe` | Speech-to-text |
| `synthesize` | Text-to-speech |
| `language.get` | Get user's language |
| `language.set` | Set user's language |

### VoiceChat Service (Unix Socket)

Socket path: `/run/user/$UID/telegram-voicechat.sock`

#### Methods

| Method | Description |
|--------|-------------|
| `status` | Service status |
| `join` | Join voice chat |
| `leave` | Leave voice chat |
| `speak` | Send TTS to voice chat |

## Troubleshooting

### "database is locked"

Another process is using the same Telegram session. Make sure only one bridge process is running:

```bash
pkill -f telegram-text-bridge
```

### Voice notes not transcribing

1. Check whisper.cpp is installed: `~/whisper.cpp/build/bin/whisper-cli --help`
2. Check model exists: `ls ~/whisper.cpp/models/`
3. Check service logs: `journalctl --user -u telegram-voice -f`

### High memory usage

whisper.cpp loads the model into RAM. Use a smaller model or increase available memory:

```bash
# Check memory usage
ps aux | grep telegram-voice | awk '{print $6/1024 "MB"}'
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Pyrogram](https://github.com/pyrogram/pyrogram) - Telegram MTProto client
- [Hydrogram](https://github.com/hydrogram/hydrogram) - Modern Pyrogram fork
- [py-tgcalls](https://github.com/pytgcalls/pytgcalls) - Telegram calls library
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) - Fast Whisper inference
- [Piper](https://github.com/rhasspy/piper) - Fast neural TTS
- [Clawdbot](https://github.com/clawdbot/clawdbot) - AI assistant framework
