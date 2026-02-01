# Quick Start: aiortc P2P Calls

Get real P2P voice calls with full audio streaming up and running in 30 minutes.

---

## Prerequisites

- Python 3.10+
- Pyrogram session configured
- Whisper.cpp installed (for STT)
- Piper installed (for TTS)

---

## 1. Install System Dependencies

### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y \
    libavdevice-dev \
    libavfilter-dev \
    libopus-dev \
    libvpx-dev \
    pkg-config \
    python3-dev \
    ffmpeg
```

### macOS

```bash
brew install ffmpeg opus libvpx pkg-config
```

---

## 2. Install Python Packages

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate

# Install all requirements
pip install -r ~/path/to/service/requirements.txt

# Or install individually:
pip install aiortc>=1.9.0
pip install aiohttp>=3.9.0
pip install av>=12.0.0
pip install numpy>=1.24.0
pip install pydub>=0.25.1
pip install webrtcvad>=2.0.10
```

---

## 3. Verify Installation

```bash
python3 << 'EOF'
import aiortc
import av
import numpy
import webrtcvad

print(f"✅ aiortc: {aiortc.__version__}")
print(f"✅ PyAV: {av.__version__}")
print(f"✅ numpy: {numpy.__version__}")
print(f"✅ webrtcvad: {webrtcvad.__version__}")
print("\n🎉 All dependencies installed!")
EOF
```

Expected output:
```
✅ aiortc: 1.9.0
✅ PyAV: 12.0.0
✅ numpy: 1.24.0
✅ webrtcvad: 2.0.10

🎉 All dependencies installed!
```

---

## 4. Test with Mock Voice Service

Edit `python/voice/test-aiortc-call.py` and configure:

```python
API_ID = 12345678  # Your API ID
API_HASH = "abc123..."  # Your API hash
PHONE = "+1234567890"  # Your phone
TARGET_USER_ID = 987654321  # User to call
```

Run the test:

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python python/voice/test-aiortc-call.py
```

Expected flow:
1. Pyrogram connects
2. Call request sent
3. When answered: Audio streams established
4. When you speak: VAD detects speech → Mock STT
5. Mock TTS plays response
6. Call ends

---

## 5. Integration with Real Voice Service

### Option A: Direct Integration

```python
from aiortc_p2p_calls import AiortcP2P Call
from your_voice_service import VoiceService

# Create voice service
voice_service = VoiceService(
    whisper_path="~/whisper.cpp/build/bin/whisper-cli",
    model_path="~/whisper.cpp/models/ggml-small.bin",
    piper_path="~/piper/piper/piper",
    voice_path="~/piper/voices/ca_ES-upc_pau-x_low.onnx"
)

# Create call service
call = AiortcP2PCall(
    client=pyrogram_client,
    voice_service=voice_service,
    on_event=event_handler
)

# Make call
await call.request_call(user_id)
```

### Option B: JSON-RPC Integration

If your voice service uses JSON-RPC (via Unix socket):

```python
class VoiceServiceProxy:
    """Proxy to JSON-RPC voice service"""

    async def transcribe(self, audio_path, **kwargs):
        result = await json_rpc_call('transcribe', {
            'audio_path': audio_path,
            **kwargs
        })
        return result

    async def synthesize(self, text, **kwargs):
        result = await json_rpc_call('synthesize', {
            'text': text,
            **kwargs
        })
        return result

# Use proxy
voice_service = VoiceServiceProxy()
call = AiortcP2PCall(client, voice_service=voice_service)
```

---

## 6. Event Handling

Handle call events to integrate with Claude/LLM:

```python
async def handle_call_events(event_type, params):
    """Process call events"""

    if event_type == "call.ringing":
        print(f"📞 Calling {params['user_id']}...")

    elif event_type == "call.connected":
        print(f"✅ Call connected!")
        # Play greeting
        await call.speak_text("Hello, how can I help you?")

    elif event_type == "call.speech":
        # User spoke
        user_text = params['text']
        print(f"🎤 User: {user_text}")

        # Process with Claude
        response = await claude.process(user_text)

        # Speak response
        await call.speak_text(response)

    elif event_type == "call.ended":
        duration = params['duration']
        print(f"📴 Call ended ({duration:.1f}s)")

# Use event handler
call = AiortcP2PCall(
    client=client,
    voice_service=voice_service,
    on_event=handle_call_events
)
```

---

## 7. Troubleshooting

### Issue: "Failed to install aiortc"

**Solution:** Install system dependencies first (see step 1)

```bash
# Ubuntu
sudo apt-get install libavdevice-dev libavfilter-dev libopus-dev

# macOS
brew install ffmpeg opus libvpx
```

### Issue: "No module named 'webrtcvad'"

**Solution:**

```bash
pip install webrtcvad
```

If that fails on your platform:
```python
# The code falls back to amplitude-based VAD automatically
# You'll see: "Using amplitude-based VAD"
```

### Issue: "Call connects but no speech detected"

**Checks:**

1. Verify microphone works in Telegram normally
2. Check audio is being received:
   ```python
   # Add debug logging in _process_incoming_audio
   log.info(f"Received frame: {frame.samples} samples")
   ```

3. Adjust VAD sensitivity:
   ```python
   # In AiortcP2PCall.__init__
   vad = webrtcvad.Vad(1)  # Try 0-3 (0=least aggressive, 3=most)
   ```

4. Lower silence threshold:
   ```python
   max_silence_frames = 50  # ~1s instead of 1.5s
   ```

### Issue: "TTS playback is choppy"

**Solution:** Ensure audio file is 48kHz mono WAV

```bash
# Convert with ffmpeg if needed
ffmpeg -i input.wav -ar 48000 -ac 1 output.wav
```

### Issue: "Call has high latency"

**Optimizations:**

1. Use faster Whisper model (`small` → `tiny`)
2. Reduce VAD pause detection (`1.5s` → `1.0s`)
3. Pre-generate common TTS phrases
4. Use lower Piper `lengthScale` for faster TTS

---

## 8. Performance Tuning

### Memory Optimization

```python
# Limit audio buffer size
max_buffer_frames = 250  # ~5s at 20ms per frame

if len(buffer) > max_buffer_frames:
    # Process partial segment
    await self._process_speech_segment(buffer[:max_buffer_frames])
    buffer = buffer[max_buffer_frames:]
```

### CPU Optimization

```python
# Use faster models
whisper_model = "tiny"  # Instead of "small" or "medium"
piper_quality = "x_low"  # Instead of "low" or "medium"
```

### Latency Optimization

```python
# Reduce silence detection time
max_silence_frames = 50  # 1.0s
min_speech_frames = 5    # Minimum frames before considering speech
```

---

## 9. Production Checklist

Before deploying to production:

- [ ] Test with multiple call sessions
- [ ] Verify audio quality with different speakers
- [ ] Test network interruptions (Wi-Fi switching)
- [ ] Measure CPU/memory usage under load
- [ ] Test call timeout handling
- [ ] Implement call recording (if needed)
- [ ] Add call quality metrics
- [ ] Test with firewall/NAT scenarios
- [ ] Verify cleanup on crashes
- [ ] Add monitoring/logging

---

## 10. Next Steps

1. **Integrate with telegram-voice-service.py**
   - Add AiortcP2PCall to existing service
   - Wire up JSON-RPC methods
   - Handle call events

2. **Connect to Clawdbot Gateway**
   - Emit events via Unix socket
   - Handle commands from Node.js
   - Integrate with conversation flow

3. **Production Hardening**
   - Error recovery
   - Network resilience
   - Call quality monitoring
   - Automatic reconnection

---

## Resources

- **aiortc Documentation:** https://aiortc.readthedocs.io/
- **Telegram Call Protocol:** https://core.telegram.org/api/end-to-end/video-calls
- **WebRTC Basics:** https://webrtc.org/getting-started/overview
- **Pyrogram Docs:** https://docs.pyrogram.org/

---

**Last Updated:** 2026-02-01
**Status:** Phase 2 Complete - Ready for Integration
**Next:** Integrate with telegram-voice-service.py
