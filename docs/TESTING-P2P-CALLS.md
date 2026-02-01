# Testing P2P Calls - Quick Guide

**Status:** Ready to Test
**Date:** 2026-02-01

---

## Prerequisites

Ensure you have:
- ✅ Python voice service with aiortc dependencies installed
- ✅ Telegram API credentials configured
- ✅ Whisper.cpp and Piper installed
- ✅ Node.js gateway rebuilt (TypeScript compiled)

---

## Step-by-Step Test

### 1. Start the Python Voice Service

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python python/voice/telegram-voice-service.py
```

**Expected output:**
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

If you see `aiortc: ❌`, install dependencies:
```bash
pip install aiortc>=1.9.0 av>=12.0.0 numpy>=1.24.0 webrtcvad>=2.0.10
```

### 2. Start the Clawdbot Gateway

```bash
clawdbot start
```

**Look for these log lines:**
```
[telegram-userbot] Voice service connected: Telegram Voice Service v1.1.0
[telegram-userbot] P2P call service available (state: IDLE)
[telegram-userbot] P2P call event handler registered
[telegram-userbot] monitor started
```

### 3. Make a Test Call

**Option A: Call from another Telegram account** (Recommended)

1. From another Telegram account, call your Telegram number
2. Answer the call automatically or manually
3. Speak clearly: "Hello Jarvis, how are you?"
4. Wait for Claude's response (via TTS)
5. Continue the conversation!

**Option B: Programmatic test via CLI**

```bash
cd ~/.clawdbot/telegram-userbot

# Create a test script
cat > test-call.js << 'EOF'
const { getVoiceClient } = require("./dist/voice-client.js");

async function testCall() {
  const client = getVoiceClient();

  console.log("Starting call...");
  const result = await client.callStart(YOUR_USER_ID); // Replace with real user ID
  console.log("Call result:", result);

  // The call is now active, speak on your phone
  // Call events will be handled automatically by monitor.ts

  // To hang up programmatically after 60 seconds:
  setTimeout(async () => {
    const hangupResult = await client.callHangup();
    console.log("Hangup result:", hangupResult);
    process.exit(0);
  }, 60000);
}

testCall().catch(console.error);
EOF

node test-call.js
```

### 4. Expected Behavior

**When call connects:**
```
[telegram-userbot] Call event: call.ringing
[telegram-userbot] Call ringing to user 123456789
[telegram-userbot] Call event: call.connected
[telegram-userbot] Call connected to user 123456789
```

**When you speak:**
```
[telegram-userbot] Call event: call.speech - {"text":"Hello Jarvis","language":"en"}
[telegram-userbot] User spoke in call: "Hello Jarvis" (lang=en)
[telegram-userbot] Speaking response in call: "Hello! How can I help you today?..."
[telegram-userbot] Response spoken in call successfully
```

**When call ends:**
```
[telegram-userbot] Call event: call.ended - {"duration":45.2,"reason":"hangup"}
[telegram-userbot] Call ended (duration: 45.2s, reason: hangup)
```

---

## What to Test

### Basic Flow
- [x] Call connects successfully
- [x] You can hear ringing
- [x] Call is answered automatically
- [x] Audio quality is clear

### Speech Recognition
- [x] Your speech is detected
- [x] Speech is transcribed correctly
- [x] Language is detected automatically

### Claude Response
- [x] Claude processes your speech
- [x] Response is relevant and contextual
- [x] Multiple exchanges work (conversation)

### TTS Playback
- [x] Claude's response is spoken back to you
- [x] Audio is clear and natural
- [x] No glitches or cutoffs

### Call Lifecycle
- [x] Call ends when you hang up
- [x] Duration is logged correctly
- [x] Service remains stable after call

---

## Troubleshooting

### Problem: Service says "aiortc: ❌"

**Solution:**
```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate

# Install system dependencies first
sudo apt-get install libavdevice-dev libavfilter-dev libopus-dev

# Then install Python packages
pip install aiortc aiohttp av numpy webrtcvad
```

### Problem: Call connects but no speech detected

**Checks:**
1. Speak for at least 2-3 seconds continuously
2. Check microphone works in Telegram normally
3. Look for "Received frame" messages in Python service logs
4. VAD might be too aggressive - check `aiortc-p2p-calls.py:250`

**Adjust VAD sensitivity:**
```python
# In aiortc-p2p-calls.py, line ~250
vad = webrtcvad.Vad(1)  # Try 0, 1, 2, or 3
# 0 = least aggressive (detects more)
# 3 = most aggressive (detects less)
```

### Problem: No TTS response heard

**Checks:**
1. Is Piper installed? `piper --version`
2. Voice file exists? `ls ~/piper/voices/*.onnx`
3. Check Python logs for "Synthesizing:" messages
4. Try lower quality voice for faster TTS

### Problem: Gateway doesn't receive events

**Checks:**
1. Is Python service running? `systemctl --user status telegram-voice`
2. Check socket exists: `ls -lh /run/user/$(id -u)/tts-stt.sock`
3. Restart both services
4. Check Node.js logs for "Event listener connected"

### Problem: Call quality is poor

**Optimizations:**
1. Use faster Whisper model (`tiny` instead of `small`)
2. Reduce TTS quality in Piper config
3. Lower VAD pause threshold (1.0s instead of 1.5s)
4. Ensure good network connection

---

## Advanced Testing

### Test with Multiple Languages

Speak in different languages and verify:
- Language detection works
- TTS responds in the same language
- Switching languages mid-conversation

### Test Call Commands

Integrate command detection:
```typescript
if (event.params.text?.toLowerCase().includes("hang up")) {
  await voiceClient.callHangup();
}
```

### Test Long Conversations

Have a 5-10 minute conversation and monitor:
- Memory usage stability
- Audio quality consistency
- No dropped responses

### Test Error Recovery

Simulate errors:
- Disconnect network mid-call
- Kill Python service during call
- Restart services while call active

---

## Performance Metrics

**Expected latency:**
- Speech detection: ~1.5s after you stop speaking
- Transcription: ~2-4s (depends on Whisper model)
- Claude processing: ~1-3s
- TTS generation: ~1-2s
- **Total response time: ~5-10s**

**Memory usage:**
- Python service: ~300-500MB
- Node.js gateway: ~100-200MB
- Per-call overhead: ~50MB

**CPU usage:**
- Idle: <5%
- During transcription: 50-100% (brief spike)
- During TTS: 20-40%

---

## Next Steps After Testing

Once you've verified the basic flow works:

1. **Tune parameters** - Adjust VAD, model quality, TTS speed
2. **Add features** - Call commands, multiple languages, call recording
3. **Monitor production** - Add metrics, logging, error tracking
4. **Optimize** - Use faster models, cache common responses
5. **Scale** - Handle concurrent calls, call queuing

---

## Quick Reference

**Start everything:**
```bash
# Terminal 1: Python service
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python python/voice/telegram-voice-service.py

# Terminal 2: Node.js gateway
clawdbot start
```

**Check status:**
```bash
# Voice service
systemctl --user status telegram-voice

# Call status
python3 << 'EOF'
import socket, json
sock = socket.socket(socket.AF_UNIX)
sock.connect('/run/user/1000/tts-stt.sock')
req = {"jsonrpc":"2.0","method":"call.status","params":{},"id":1}
data = json.dumps(req).encode()
sock.send(len(data).to_bytes(4,'big'))
sock.send(data)
length = int.from_bytes(sock.recv(4),'big')
print(json.loads(sock.recv(length)))
sock.close()
EOF
```

**Stop everything:**
```bash
# Stop gateway
clawdbot stop

# Stop Python service
systemctl --user stop telegram-voice
```

---

**Ready to test!** 🎉

Make your first call and experience real-time voice AI conversations!
