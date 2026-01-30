# telegram-userbot

🎙️ **Telegram Userbot Plugin for Clawdbot**

Text and voice conversations with your Clawdbot assistant through Telegram userbot - 100% local STT/TTS!

## ✨ Features

- 💬 **Text messaging** - Chat with your assistant via Telegram
- 🎤 **Voice notes** - Send/receive voice messages
- 📞 **Voice calls** - Real-time voice conversations (WIP)
- 🔊 **Local STT** - Whisper.cpp for speech-to-text (no API costs)
- 🔈 **Local TTS** - Piper for text-to-speech (no API costs)
- 🧠 **Full Clawdbot integration** - Personality, memory, tools

## ⚠️ Userbot vs Bot

This plugin uses a **Telegram userbot** (MTProto API), NOT a BotFather bot:

| BotFather Bot | Userbot (this plugin) |
|---------------|----------------------|
| Bot API | MTProto API (Pyrogram) |
| Cannot make calls | ✅ Can make voice calls |
| Limited features | Full user access |
| grammY/Telegraf | Pyrogram |

## 📋 Requirements

- Clawdbot >= 2026.1.0
- Python 3.10+ with Pyrogram
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) (compiled)
- [Piper TTS](https://github.com/rhasspy/piper) (with voice models)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

## 🚀 Installation

### Option 1: Link for development

```bash
# Clone the repo
git clone https://github.com/carles-abarca/clawdbot-telegram-userbot
cd clawdbot-telegram-userbot
npm install

# Link to Clawdbot
clawdbot plugins install -l .
# Or manually:
ln -s $(pwd) ~/.clawdbot/extensions/telegram-userbot

# Enable
clawdbot plugins enable telegram-userbot
```

### Option 2: Add to load paths

Add to `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/clawdbot-telegram-userbot"]
    }
  }
}
```

## ⚙️ Configuration

Add to your `clawdbot.json`:

```json5
{
  "plugins": {
    "entries": {
      "telegram-userbot": {
        "enabled": true,
        "config": {
          "telegram": {
            "apiId": 12345678,
            "apiHash": "your_api_hash",
            "phone": "+1234567890",
            "sessionPath": "/path/to/session/dir"
          },
          "stt": {
            "provider": "whisper-cpp",
            "whisperPath": "/path/to/whisper-cli",
            "modelPath": "/path/to/ggml-small.bin",
            "language": "auto"
          },
          "tts": {
            "provider": "piper",
            "piperPath": "/path/to/piper",
            "voicePath": "/path/to/voice.onnx",
            "lengthScale": 0.85
          },
          "allowedUsers": [123456789]  // Telegram user IDs
        }
      }
    }
  }
}
```

## 🔧 Plugin Structure (for developers)

### Required files for a Clawdbot plugin:

```
telegram-userbot/
├── index.ts              # Entry point (exports plugin object)
├── clawdbot.plugin.json  # Plugin manifest
├── package.json          # With clawdbot.extensions field
├── src/
│   ├── telegram-bridge.ts
│   ├── stt.ts
│   └── tts.ts
└── dist/                 # Compiled JS (optional if using jiti)
```

### clawdbot.plugin.json

```json
{
  "id": "telegram-userbot",
  "channels": ["telegram-userbot"],
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": { ... }
  }
}
```

### package.json (critical fields)

```json
{
  "name": "telegram-userbot",  // Must match plugin id!
  "clawdbot": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "telegram-userbot",
      "label": "Telegram Userbot",
      ...
    }
  }
}
```

### index.ts (export format)

```typescript
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

const plugin = {
  id: "telegram-userbot",           // Must match manifest id
  name: "Telegram Userbot",
  description: "...",
  configSchema: { ... },
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: channelPlugin });
  },
};

export default plugin;  // Export object, not function!
```

### Key learnings:

1. **Plugin ID consistency**: The `id` must match in:
   - `clawdbot.plugin.json` → `id`
   - `package.json` → `name` (without scope)
   - `index.ts` → `plugin.id`

2. **Discovery paths**: Clawdbot finds plugins at:
   - `~/.clawdbot/extensions/*/index.ts`
   - `plugins.load.paths` in config

3. **Export format**: Must export an object with `{ id, name, register() }`, not a function directly.

4. **TypeScript**: Clawdbot uses jiti to load `.ts` files directly.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Telegram App                             │
│              (Text / Voice / Calls)                         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                telegram-userbot plugin                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │     Pyrogram (Python) ←→ Node.js Bridge               │ │
│  └──────────┬─────────────────────────────┬───────────────┘ │
│             │                             │                 │
│             ▼                             ▼                 │
│  ┌──────────────────┐          ┌──────────────────────┐    │
│  │  Whisper.cpp     │          │  Piper TTS           │    │
│  │  (Local STT)     │          │  (Local TTS)         │    │
│  └────────┬─────────┘          └──────────▲───────────┘    │
│           │                               │                 │
│           └───────────────────────────────┘                 │
│                       │                                     │
│                       ▼                                     │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Clawdbot Core                             │ │
│  │  - Claude API                                          │ │
│  │  - Personality, Memory, Tools                          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🎤 Voice Models

### Piper TTS
- 🇬🇧 English: `en_US-lessac-medium`
- 🇪🇸 Spanish: `es_ES-sharvard-medium`
- 🏴󠁥󠁳󠁣󠁴󠁿 Catalan: `ca_ES-upc_ona-medium`, `ca_ES-upc_pau-x_low`
- [Full list](https://rhasspy.github.io/piper-samples/)

### Whisper.cpp Models
- `tiny` - Fastest
- `small` - Recommended ✅
- `medium` - Better accuracy
- `large` - Best accuracy

## 📊 Status

- ✅ Text messaging
- ✅ Voice notes (send/receive)
- ✅ Whisper STT integration
- ✅ Piper TTS integration
- ⏳ Voice calls (in progress)
- ⏳ Full Clawdbot session integration

## 📜 License

MIT © [Carles Abarca](https://github.com/carlesabarca)
