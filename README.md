# @carlesabarca/clawdbot-telegram-voice

🎙️ **Telegram Voice Calls Plugin for Clawdbot**

Have real voice conversations with your Clawdbot assistant through Telegram - 100% local, 100% free!

## ✨ Features

- 📞 **Voice calls via Telegram** - Call your assistant like calling a friend
- 🎤 **Local STT** - Whisper.cpp for speech-to-text (no API costs)
- 🔊 **Local TTS** - Piper for text-to-speech (no API costs)
- 🧠 **Full Clawdbot integration** - Personality, memory, tools, everything
- 💰 **Zero operational costs** - Everything runs locally
- 🔒 **Privacy-first** - Audio never leaves your server

## 📋 Requirements

- Clawdbot >= 2026.1.0
- Python 3.10+
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) (compiled)
- [Piper TTS](https://github.com/rhasspy/piper) (with voice models)
- Telegram account (for userbot)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

## 🚀 Quick Start

### 1. Install the plugin

```bash
clawdbot plugins install @carlesabarca/clawdbot-telegram-voice
```

### 2. Configure

Add to your `clawdbot.json`:

```json5
{
  "plugins": {
    "entries": {
      "telegram-voice": {
        "enabled": true,
        "config": {
          "telegram": {
            "apiId": 12345678,
            "apiHash": "your_api_hash",
            "phone": "+1234567890"
          },
          "stt": {
            "provider": "whisper-cpp",
            "whisperPath": "/path/to/whisper-cli",
            "modelPath": "/path/to/ggml-small.bin"
          },
          "tts": {
            "provider": "piper",
            "piperPath": "/path/to/piper",
            "voicePath": "/path/to/voice.onnx"
          },
          "allowedUsers": [123456789]  // Telegram user IDs
        }
      }
    }
  }
}
```

### 3. First run (authentication)

```bash
clawdbot telegram-voice auth
# Follow prompts to enter verification code
```

### 4. Start

```bash
clawdbot gateway start
```

Now call your Telegram userbot number! 📱

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Telegram (your phone)                       │
│                 - Text messages                             │
│                 - Voice calls                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Plugin: telegram-voice                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  pytgcalls (Python) ←→ Node.js bridge                 │ │
│  │  - Receives voice stream                               │ │
│  │  - Sends audio response                                │ │
│  └──────────┬─────────────────────────────┬───────────────┘ │
│             │                             │                 │
│             ▼                             ▼                 │
│  ┌──────────────────┐          ┌──────────────────────┐     │
│  │  Whisper.cpp     │          │  Piper TTS           │     │
│  │  (Local STT)     │          │  (Local TTS)         │     │
│  └────────┬─────────┘          └──────────▲───────────┘     │
│           │                               │                 │
│           └───────────┬───────────────────┘                 │
│                       ▼                                     │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Clawdbot Core                             │ │
│  │  - Agent personality (SOUL.md)                         │ │
│  │  - Memory (MEMORY.md)                                  │ │
│  │  - Tools (calendar, email, etc.)                       │ │
│  │  - Claude API (your subscription)                      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 💰 Cost Comparison

| Component | This Plugin | Cloud Alternative |
|-----------|-------------|-------------------|
| STT | $0 (Whisper local) | ~$0.006/min (Whisper API) |
| TTS | $0 (Piper local) | ~$0.03/1K chars (ElevenLabs) |
| LLM | $0 (Claude Max sub) | ~$0.015/1K tokens |
| **Total per hour** | **$0** | **~$5-15** |

## 🎤 Supported Voice Models

### Piper TTS (recommended)
- 🇬🇧 English: `en_US-lessac-medium`
- 🇪🇸 Spanish: `es_ES-sharvard-medium`
- 🇫🇷 French: `fr_FR-upmc-medium`
- 🇩🇪 German: `de_DE-thorsten-medium`
- 🏴󠁥󠁳󠁣󠁴󠁿 Catalan: `ca_ES-upc_ona-medium`
- [Full list](https://rhasspy.github.io/piper-samples/)

### Whisper.cpp Models
- `tiny` - Fastest, lower accuracy
- `base` - Good balance
- `small` - Recommended ✅
- `medium` - Better accuracy, slower
- `large` - Best accuracy, slowest

## 🛠️ CLI Commands

```bash
# Authentication
clawdbot telegram-voice auth

# Status
clawdbot telegram-voice status

# Test TTS
clawdbot telegram-voice test-tts "Hello world"

# Test STT
clawdbot telegram-voice test-stt /path/to/audio.wav

# Logs
clawdbot telegram-voice logs --follow
```

## 📊 Latency

Expected latency per turn:

| Step | Time |
|------|------|
| Audio capture | ~100ms |
| Whisper STT | 500ms - 2s |
| Claude response | 1s - 3s |
| Piper TTS | 100ms - 300ms |
| Audio playback | ~100ms |
| **Total** | **~2-5 seconds** |

## 🤝 Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md).

## 📜 License

MIT © [Carles Abarca](https://github.com/carlesabarca)

## 🙏 Acknowledgments

- [Clawdbot](https://github.com/clawdbot/clawdbot) - The amazing AI assistant framework
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) - Fast local speech recognition
- [Piper](https://github.com/rhasspy/piper) - High quality local TTS
- [pytgcalls](https://github.com/pytgcalls/pytgcalls) - Telegram voice calls library
