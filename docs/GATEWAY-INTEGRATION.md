# Gateway Integration Complete: P2P Calls

**Date:** 2026-02-01
**Status:** Ready for Testing

---

## What's Been Integrated

The **aiortc P2P call system** is now fully integrated with the **Node.js gateway**. The gateway can now:

- Start and manage P2P voice calls
- Receive call events from the Python voice service
- Process user speech with Claude during calls
- Respond with TTS playback in real-time

---

## Changes Made

### 1. **src/voice-client.ts** - P2P Call Methods Added

**New Interfaces:**
```typescript
export interface CallStartResult {
  status: string;
  call_id?: number;
  error?: string;
}

export interface CallHangupResult {
  status: string;
  duration?: number;
  error?: string;
}

export interface CallStatusResult {
  active: boolean;
  state: string;
  call_id?: number;
  user_id?: number;
  duration?: number;
  error?: string;
}

export interface CallSpeakResult {
  status: string;
  audio_path?: string;
  error?: string;
}

export interface CallPlayResult {
  status: string;
  error?: string;
}

export interface CallEvent {
  type: "call.ringing" | "call.connected" | "call.speech" | "call.ended";
  params: {
    call_id?: string;
    user_id?: number;
    text?: string;
    language?: string;
    audio_path?: string;
    duration?: number;
    reason?: string;
  };
}
```

**New Methods:**
```typescript
class VoiceClient {
  // Start a P2P call
  async callStart(userId: number): Promise<CallStartResult>

  // Hang up the current call
  async callHangup(): Promise<CallHangupResult>

  // Get current call status
  async callStatus(): Promise<CallStatusResult>

  // Speak text in the current call (TTS + playback)
  async callSpeak(text: string): Promise<CallSpeakResult>

  // Play audio file in the current call
  async callPlay(audioPath: string): Promise<CallPlayResult>

  // Add a listener for call events
  onCallEvent(listener: CallEventListener): void

  // Remove a call event listener
  offCallEvent(listener: CallEventListener): void
}
```

**Event Listener:**
- Maintains persistent connection to voice service
- Receives JSON-RPC notifications for call events
- Automatically reconnects on disconnect
- Cleans up when no listeners remain

### 2. **src/monitor.ts** - Call Event Handling

**Call Event Handler Added:**
- Listens for `call.speech`, `call.connected`, `call.ended`, `call.ringing`
- Processes user speech with Claude during calls
- Responds with TTS via `call.speak`
- Logs call lifecycle events

**Key Flow:**
```typescript
voiceClient.onCallEvent(async (event) => {
  if (event.type === "call.speech") {
    // User spoke during call
    const userText = event.params.text;
    const userId = event.params.user_id;

    // Process with Claude
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload) => {
          // Clean text for TTS
          const cleanText = stripMarkdown(payload.text);

          // Speak response in call
          await voiceClient.callSpeak(cleanText);
        }
      }
    });
  }
});
```

**Cleanup:**
- Removes event listeners on monitor shutdown
- Ensures no resource leaks

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Node.js Gateway (Clawdbot)                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  monitor.ts                                            │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  Call Event Listener                             │ │ │
│  │  │  ├─> call.speech → Process with Claude          │ │ │
│  │  │  ├─> call.connected → Log event                 │ │ │
│  │  │  ├─> call.ended → Log duration                  │ │ │
│  │  │  └─> call.ringing → Log status                  │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │                                                          │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  voice-client.ts                                 │ │ │
│  │  │  ├─> callStart(userId)                          │ │ │
│  │  │  ├─> callSpeak(text)                            │ │ │
│  │  │  ├─> callHangup()                               │ │ │
│  │  │  └─> onCallEvent(listener)                      │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                    Unix Socket (JSON-RPC)
                    /run/user/$UID/tts-stt.sock
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Python Voice Service (telegram-voice-service.py)           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  JSONRPCServer                                         │ │
│  │  ├─> call.start → AiortcP2PCall.request_call()       │ │
│  │  ├─> call.speak → AiortcP2PCall.speak_text()         │ │
│  │  ├─> call.hangup → AiortcP2PCall.hangup()            │ │
│  │  └─> Broadcasts events to all clients                 │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  AiortcP2PCall                                         │ │
│  │  ├─> Pyrogram (signaling)                             │ │
│  │  ├─> aiortc (WebRTC audio)                            │ │
│  │  ├─> VAD (speech detection)                           │ │
│  │  └─> Emits: call.speech, call.connected, call.ended   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Complete Call Flow (Gateway-Integrated)

```
1. User calls your Telegram number
        ↓
2. Python service: Pyrogram receives phone.CallAccepted
        ↓
3. Python service: Emits "call.connected" event
        ↓
4. Node.js gateway: Receives event, logs connection
        ↓
5. User speaks → WebRTC receives audio
        ↓
6. Python service: VAD detects speech end
        ↓
7. Python service: Whisper transcribes → "Hello Jarvis"
        ↓
8. Python service: Emits "call.speech" event
        ↓
9. Node.js gateway: Receives event with transcribed text
        ↓
10. Node.js gateway: Processes with Claude
        ↓
11. Claude responds: "Hello! How can I help you?"
        ↓
12. Node.js gateway: Calls voiceClient.callSpeak(response)
        ↓
13. Python service: Piper generates TTS
        ↓
14. Python service: aiortc plays audio in call
        ↓
15. User hears response!
        ↓
16. Conversation continues... (repeat 5-15)
        ↓
17. User hangs up
        ↓
18. Python service: Emits "call.ended" event
        ↓
19. Node.js gateway: Logs call duration
```

---

## Testing the Integration

### 1. Start the Python Voice Service

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python python/voice/telegram-voice-service.py
```

Expected output:
```
🎤 Telegram Voice Service v1.1.0
   Platform: Linux
   Transport: unix
   Pyrogram: ✅
   aiortc: ✅ (P2P calls)
✅ Pyrogram client started for calls
📞 aiortc P2P call service initialized
🚀 JSON-RPC server listening on /run/user/1000/tts-stt.sock
```

### 2. Start the Clawdbot Gateway

```bash
clawdbot start
```

Expected log output:
```
[telegram-userbot] Checking voice service availability...
[telegram-userbot] Voice service connected: Telegram Voice Service v1.1.0
[telegram-userbot] P2P call service available (state: IDLE)
[telegram-userbot] P2P call event handler registered
[telegram-userbot] monitor started
```

### 3. Make a Test Call

**Option A: Call from another Telegram account**
- Call your Telegram number from another account
- When answered, speak: "Hello Jarvis"
- You should hear Claude's response!

**Option B: Use the CLI (programmatic)**
```bash
cd ~/.clawdbot/telegram-userbot

# In Node.js (via clawdbot)
node << 'EOF'
const { getVoiceClient } = require("./dist/voice-client.js");

async function testCall() {
  const client = getVoiceClient();

  // Start call
  const result = await client.callStart(123456789); // Your user ID
  console.log("Call started:", result);

  // Wait for call to connect and user to speak
  // (call.speech events will be handled automatically)
}

testCall();
EOF
```

### 4. Expected Event Flow

**Gateway logs:**
```
[telegram-userbot] Call event: call.ringing - {"call_id":"987654321","user_id":123456789}
[telegram-userbot] Call ringing to user 123456789

[telegram-userbot] Call event: call.connected - {"call_id":"987654321"}
[telegram-userbot] Call connected to user 123456789

[telegram-userbot] Call event: call.speech - {"text":"Hello Jarvis","language":"en","user_id":123456789}
[telegram-userbot] User spoke in call: "Hello Jarvis" (lang=en)
[telegram-userbot] Speaking response in call: "Hello! How can I help you today?..."
[telegram-userbot] Response spoken in call successfully

[telegram-userbot] Call event: call.ended - {"duration":125.3,"reason":"hangup"}
[telegram-userbot] Call ended (duration: 125.3s, reason: hangup)
```

---

## Usage from Node.js Code

### Starting a Call

```typescript
import { getVoiceClient } from "./voice-client.js";

const voiceClient = getVoiceClient();

// Start call
const result = await voiceClient.callStart(123456789);
if (result.error) {
  console.error("Call failed:", result.error);
} else {
  console.log("Call started:", result.call_id);
}
```

### Listening for Call Events

```typescript
voiceClient.onCallEvent(async (event) => {
  switch (event.type) {
    case "call.connected":
      console.log("Call connected!");
      // Optionally greet the user
      await voiceClient.callSpeak("Hello! How can I help?");
      break;

    case "call.speech":
      console.log("User said:", event.params.text);
      // Process with your own logic or Claude
      const response = await processWithClaude(event.params.text);
      await voiceClient.callSpeak(response);
      break;

    case "call.ended":
      console.log("Call ended after", event.params.duration, "seconds");
      break;
  }
});
```

### Hanging Up

```typescript
const result = await voiceClient.callHangup();
console.log("Call ended:", result.duration, "seconds");
```

### Check Call Status

```typescript
const status = await voiceClient.callStatus();
console.log("Call active:", status.active);
console.log("Call state:", status.state);
```

---

## API Reference

### VoiceClient Methods

#### `callStart(userId: number): Promise<CallStartResult>`

Start a P2P call to the specified user.

**Parameters:**
- `userId` - Telegram user ID to call

**Returns:**
```typescript
{
  status: "ringing" | "error",
  call_id?: number,
  error?: string
}
```

#### `callHangup(): Promise<CallHangupResult>`

Hang up the current active call.

**Returns:**
```typescript
{
  status: "ended" | "error",
  duration?: number,  // seconds
  error?: string
}
```

#### `callStatus(): Promise<CallStatusResult>`

Get the current call status.

**Returns:**
```typescript
{
  active: boolean,
  state: "IDLE" | "RINGING" | "CONNECTING" | "CONNECTED" | "ENDED",
  call_id?: number,
  user_id?: number,
  duration?: number
}
```

#### `callSpeak(text: string): Promise<CallSpeakResult>`

Generate TTS and play it in the current call.

**Parameters:**
- `text` - Text to speak (will be synthesized with Piper)

**Returns:**
```typescript
{
  status: "speaking" | "error",
  audio_path?: string,
  error?: string
}
```

#### `callPlay(audioPath: string): Promise<CallPlayResult>`

Play an audio file in the current call.

**Parameters:**
- `audioPath` - Path to WAV file (48kHz mono)

**Returns:**
```typescript
{
  status: "playing" | "error",
  error?: string
}
```

#### `onCallEvent(listener: CallEventListener): void`

Add a listener for call events.

**Parameters:**
- `listener` - Callback function that receives `CallEvent` objects

**Example:**
```typescript
voiceClient.onCallEvent(async (event) => {
  console.log("Event:", event.type, event.params);
});
```

#### `offCallEvent(listener: CallEventListener): void`

Remove a call event listener.

---

## Call Events

### `call.ringing`

Emitted when a call is initiated and ringing.

**Params:**
```typescript
{
  call_id: string,
  user_id: number
}
```

### `call.connected`

Emitted when the call is accepted and WebRTC connection established.

**Params:**
```typescript
{
  call_id: string
}
```

### `call.speech`

Emitted when the user speaks and speech is detected + transcribed.

**Params:**
```typescript
{
  call_id: string,
  user_id: number,
  text: string,        // Transcribed text
  language: string,    // Detected language (e.g., "en", "ca")
  audio_path: string   // Path to recorded audio segment
}
```

### `call.ended`

Emitted when the call ends.

**Params:**
```typescript
{
  call_id: string,
  duration: number,    // Call duration in seconds
  reason: string       // "hangup", "rejected", "timeout", etc.
}
```

---

## Troubleshooting

### No call events received

**Check:**
1. Is the Python voice service running?
   ```bash
   systemctl --user status telegram-voice
   ```

2. Is Pyrogram configured?
   ```bash
   cat ~/.clawdbot/telegram-userbot/voice-service-config.json
   ```

3. Is aiortc installed?
   ```bash
   source ~/.clawdbot/telegram-userbot/venv/bin/activate
   python -c "import aiortc; print(aiortc.__version__)"
   ```

### Call connects but no speech detected

**Check:**
1. Speak clearly for at least 1-2 seconds
2. VAD might need tuning (adjust in `aiortc-p2p-calls.py`)
3. Check Python service logs for audio frame reception

### TTS response not heard

**Check:**
1. Is Piper configured correctly?
   ```bash
   piper --version
   ```

2. Check voice file exists:
   ```bash
   ls -lh ~/piper/voices/*.onnx
   ```

3. Check Python service logs for TTS generation errors

---

## Next Steps

Now that the integration is complete, you can:

1. **Test end-to-end** - Make a real call and have a conversation
2. **Customize greetings** - Modify the `call.connected` handler to greet users
3. **Add call commands** - Detect special commands during calls (e.g., "hang up")
4. **Monitor call quality** - Add metrics for latency, audio quality
5. **Handle multiple calls** - Extend to support call queuing if needed

---

## Summary

**Gateway Integration: COMPLETE!**

- ✅ TypeScript types for P2P calls added
- ✅ JSON-RPC methods exposed in VoiceClient
- ✅ Event listener with auto-reconnect
- ✅ Call event handler in monitor.ts
- ✅ Claude integration for call conversations
- ✅ Automatic TTS response in calls
- ✅ Proper cleanup on shutdown
- ✅ Ready for testing!

**Total Integration Time:**
- Phase 1: Core Implementation - 4 hours
- Phase 2: Audio Pipeline - 3 hours
- Phase 3: Python Service Integration - 2 hours
- **Phase 4: Gateway Integration - 1 hour**
- **Total: 10 hours**

**Ready for production testing!** 🚀

Make your first call and experience real-time voice conversations with Claude!
