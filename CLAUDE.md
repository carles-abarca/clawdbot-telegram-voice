# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Telegram userbot plugin for Clawdbot that enables text messaging, voice notes, and voice calls using your personal Telegram account (not a bot). The system uses 100% local STT/TTS with whisper.cpp and Piper.

## Architecture

**Two-process architecture for stability and resource management:**

1. **telegram-userbot plugin (Node.js/TypeScript)** - Lightweight gateway process
   - Handles text messaging via Pyrogram bridge (Python subprocess)
   - Delegates heavy voice processing to external service
   - Lives in `src/` directory

2. **telegram-voice-service (Python)** - Separate systemd/launchd service
   - Handles STT/TTS for voice notes
   - Manages P2P voice calls with PyTgCalls
   - Exposes JSON-RPC API via Unix socket (Linux) or TCP localhost (macOS)
   - Lives in `python/voice/` directory

**Communication:** Plugin ↔ Voice Service via JSON-RPC 2.0 over Unix socket (`/run/user/$UID/tts-stt.sock` on Linux) or TCP (127.0.0.1:18790 on macOS).

## Key Components

### TypeScript/Node.js Plugin (`src/`)

- **channel.ts** - Main channel plugin definition, implements Clawdbot ChannelPlugin interface
- **telegram-bridge.ts** - Manages Python subprocess running Pyrogram for text messaging
- **monitor.ts** - Handles incoming messages and voice contexts
- **voice-client.ts** - JSON-RPC client for telegram-voice-service
- **voice-context.ts** - Manages voice message context (when to respond with TTS vs text)
- **config.ts** - Configuration types and path expansion utilities
- **stt.ts / tts.ts** - Legacy direct STT/TTS wrappers (kept for backward compatibility)

### Python Services (`python/`)

- **bridge/telegram-text-bridge.py** - Pyrogram subprocess for text messaging and calls signaling
- **voice/telegram-voice-service.py** - Main voice service with JSON-RPC server, STT/TTS, and call handling
- **voice/tts-stt-service.py** - Alternative lightweight TTS/STT-only service
- **cli/** - CLI tools for testing (telegram-call-cli.py, telegram-voice-cli.py)

### Service Management (`service/`)

- **systemd/** - Linux systemd unit files
- **telegram-voicechat-service.py** - Legacy voice chat service (being phased out)

## Build Commands

```bash
# Build TypeScript
npm run build

# Watch mode for development
npm run dev

# Clean build artifacts
npm run clean
```

## Testing

```bash
# No automated tests yet
npm test  # Currently just echoes "No tests yet"

# Manual testing via Clawdbot
clawdbot plugins list
clawdbot plugins enable telegram-userbot
clawdbot start
```

## Voice Service Management

### Linux (systemd)
```bash
# Start/stop voice service
systemctl --user start telegram-voice
systemctl --user stop telegram-voice

# View logs
journalctl --user -u telegram-voice -f
```

### macOS (launchd)
```bash
# Start/stop voice service
launchctl start com.clawdbot.telegram-voice
launchctl stop com.clawdbot.telegram-voice

# View logs
tail -f ~/.clawdbot/telegram-userbot/logs/stdout.log
```

## Configuration

Add to `~/.clawdbot/clawdbot.json`:

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
        "detectModelPath": "~/whisper.cpp/models/ggml-medium.bin",
        "language": "auto",
        "threads": 4
      },
      "tts": {
        "provider": "piper",
        "piperPath": "~/piper/piper/piper",
        "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
        "lengthScale": 0.85
      }
    }
  }
}
```

**Important:** Paths support `~` and `$HOME` expansion via `expandPath()` in config.ts.

## Voice Note Flow

1. **Incoming voice note** → telegram-text-bridge.py detects it
2. **Bridge sends to voice service** via Unix socket: `{"method": "transcribe", "params": {"audio_path": "..."}}`
3. **Voice service** runs whisper.cpp with two-stage process:
   - Stage 1: Detect language with medium model (~5s)
   - Stage 2: Transcribe with small model using detected language (~8s)
4. **Check for wake word** (default: "Jarvis")
   - If present: Set voice context, send to Clawdbot for processing
   - If absent: Request transcription+translation from Claude
5. **Response:**
   - Voice context set → Generate TTS response via Piper, send as voice note
   - No voice context → Send text response

**Telegram actions during processing:**
- "Sending a file" while transcribing (refresh every 4s to avoid 5s timeout)
- "Recording voice" when generating TTS response
- "Typing" when sending text response

## P2P Voice Calls (Experimental)

**Status:** Infrastructure complete, audio streaming has issues with tgcalls v3.0.0.6 DEV (segfault in NativeInstance.startCall()).

**How it works:**
- Signaling via Pyrogram (phone.RequestCall, phone.ConfirmCall)
- Audio streaming via tgcalls (NativeInstance)
- Managed by telegram-voice-service.py
- JSON-RPC methods: `call.start`, `call.accept`, `call.reject`, `call.hangup`, `call.status`
- Events: `call.incoming`, `call.connected`, `call.ended`

**Note:** Uses separate Telegram session (`session_voice.session`) to avoid SQLite conflicts with main bridge.

## Session Management

The system uses **two separate Telegram sessions** from the same account:
- `session.session` - Used by telegram-text-bridge.py (messages)
- `session_voice.session` - Used by telegram-voice-service.py (calls)

This is similar to having Telegram open on both phone and desktop simultaneously.

## Important Patterns

### Voice Context
When a user sends a voice note, the system sets a "voice context" that expires after processing. If the context exists when sending a response, the system automatically converts the text response to TTS and sends a voice note instead.

### Path Expansion
All file paths in configuration support `~` and `$HOME` expansion. Use `expandPath()` from config.ts when processing config values.

### Process Management
The telegram-bridge.ts implements `killOrphanedProcesses()` to clean up zombie Python processes on startup, preventing SQLite "database is locked" errors.

### Language Detection
Voice notes use smart two-stage processing:
1. Fast language detection with medium model
2. Accurate transcription with small model + forced language

This provides better accuracy than single-stage `-l auto` while maintaining reasonable speed.

## TypeScript Configuration

- **Target:** ES2022
- **Module:** NodeNext (ESM with .js extensions in imports)
- **Output:** dist/ directory
- **Source maps:** Enabled for debugging

## Common Pitfalls

1. **Don't forget .js extension in imports** - TypeScript with NodeNext requires explicit .js extensions even for .ts files
2. **Whisper defaults to English** - Always pass `-l auto` flag explicitly
3. **Telegram actions expire after 5s** - Use refresh interval of 4s for long operations
4. **Multiple Pyrogram instances cause SQLite locks** - Use separate sessions for bridge vs voice service
5. **UPLOAD_AUDIO shows "Recording voice"** - Use UPLOAD_DOCUMENT to show "Sending a file" instead

## Dependencies

### Node.js (package.json)
- `@sinclair/typebox` - Runtime type validation
- `zod` - Schema validation
- TypeScript 5.3+ for development

### Python (service/requirements.txt)
- `pyrogram` / `pyrofork` - Telegram MTProto client
- `TgCrypto` - Crypto for Pyrogram
- `pytgcalls` - Voice calls (experimental)
- `tgcalls` - WebRTC bindings (experimental)
- `pydub` - Audio manipulation
- `aiofiles` - Async file operations

### External Tools
- **whisper.cpp** - Fast local STT (models: tiny, base, small, medium)
- **Piper** - Fast local TTS (voices for Catalan, Spanish, English)
- **ffmpeg** - Audio format conversion

## File Structure

```
.
├── src/                    # TypeScript plugin source
├── python/                 # Python services
│   ├── bridge/            # Text messaging bridge
│   ├── voice/             # Voice service + CLI tools
│   ├── voicechat/         # Legacy voice chat (deprecated)
│   └── cli/               # Testing CLIs
├── service/               # Systemd/launchd service files
├── scripts/               # Installation scripts
├── docs/                  # Architecture documentation
├── dist/                  # Compiled TypeScript (generated)
├── package.json           # Node.js package definition
├── clawdbot.plugin.json   # Clawdbot plugin manifest
└── tsconfig.json          # TypeScript configuration
```

## Development Workflow

1. Make changes to TypeScript files in `src/`
2. Build with `npm run build` (or `npm run dev` for watch mode)
3. Restart Clawdbot to load changes: `clawdbot restart`
4. Check logs: `clawdbot logs` (for plugin) or `journalctl --user -u telegram-voice -f` (for voice service)

For Python service changes:
1. Edit `python/voice/telegram-voice-service.py`
2. Restart service: `systemctl --user restart telegram-voice` (Linux) or `launchctl stop/start` (macOS)
3. Check logs: `journalctl --user -u telegram-voice -f` (Linux) or `tail -f ~/.clawdbot/telegram-userbot/logs/stdout.log` (macOS)

## JSON-RPC API (Voice Service)

### Methods (Plugin → Service)
- `health` - Health check
- `status` - Service status
- `transcribe` - Speech-to-text (params: {audio_path, user_id?, conversation_id?})
- `synthesize` - Text-to-speech (params: {text, user_id?, conversation_id?})
- `language.get` - Get user's language preference
- `language.set` - Set user's language preference
- `call.start` - Start outgoing call
- `call.accept` - Accept incoming call
- `call.reject` - Reject incoming call
- `call.hangup` - Hang up active call
- `call.status` - Get call status

### Events (Service → Plugin)
- `call.incoming` - Incoming call detected
- `call.connected` - Call connected
- `call.ended` - Call ended
- `call.error` - Call error occurred

## Plugin System Integration

This plugin follows Clawdbot's ChannelPlugin pattern:
- Implements `ChannelPlugin<ResolvedTelegramUserbotAccount>` interface
- Supports both legacy single-account and new multi-account configuration
- Provides DM policy with allowlist based on `allowedUsers`
- Declares voice capabilities: `voice: true`, `voiceNotes: true`
- Implements reload on config changes: `reload.configPrefixes: ["channels.telegram-userbot"]`
