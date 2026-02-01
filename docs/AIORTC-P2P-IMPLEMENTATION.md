# aiortc P2P Call Implementation Guide

**Status:** 🚧 In Development
**Approach:** Custom WebRTC using aiortc + Pyrogram
**Goal:** Real P2P voice calls with full audio streaming

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Clawdbot Gateway (Node.js)                     │
│  └─> JSON-RPC to Voice Service                  │
└────────────────┬────────────────────────────────┘
                 │ Unix Socket
                 ▼
┌─────────────────────────────────────────────────┐
│  Voice Service (Python)                         │
│  ├─> AiortcP2PCall (NEW)                        │
│  │    ├─> Pyrogram (MTProto signaling)          │
│  │    └─> aiortc (WebRTC audio)                 │
│  │                                               │
│  ├─> WhisperSTT (existing)                      │
│  └─> PiperTTS (existing)                        │
└─────────────────────────────────────────────────┘
```

### How It Works

1. **Signaling (Pyrogram)**
   - phone.RequestCall → Initiate call
   - Diffie-Hellman key exchange
   - phone.AcceptCall / phone.ConfirmCall
   - Extract ICE servers from Telegram

2. **Audio Transport (aiortc)**
   - RTCPeerConnection for WebRTC
   - Opus codec for audio
   - RTP/SRTP for packet transport
   - ICE for NAT traversal

3. **Audio Processing**
   - Incoming: WebRTC → WAV → Whisper STT
   - Outgoing: Piper TTS → WAV → WebRTC
   - Voice Activity Detection (VAD) for speech segments

---

## Installation

### 1. Install System Dependencies

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y \
    libavdevice-dev \
    libavfilter-dev \
    libopus-dev \
    libvpx-dev \
    pkg-config \
    python3-dev
```

**macOS:**
```bash
brew install ffmpeg opus libvpx pkg-config
```

### 2. Install Python Packages

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate

pip install aiortc>=1.9.0
pip install aiohttp>=3.9.0
pip install av>=12.0.0
pip install numpy>=1.24.0
pip install pydub>=0.25.1
```

### 3. Verify Installation

```bash
python -c "import aiortc; print(f'aiortc {aiortc.__version__}')"
python -c "import av; print(f'PyAV {av.__version__}')"
python -c "import numpy; print(f'numpy {numpy.__version__}')"
```

Expected output:
```
aiortc 1.9.0
PyAV 12.0.0
numpy 1.24.0
```

---

## Implementation Status

### ✅ Phase 1: Core Implementation (Completed)

- [x] AiortcP2PCall class created
- [x] Pyrogram signaling integration
- [x] Diffie-Hellman key exchange
- [x] WebRTC connection setup
- [x] CallAudioTrack for audio streaming
- [x] Basic event system

### 🔄 Phase 2: Audio Pipeline (In Progress)

- [x] Incoming audio track handling
- [x] Voice Activity Detection (VAD) skeleton
- [x] Speech segment detection
- [ ] **TODO:** Complete VAD implementation
- [ ] **TODO:** Integrate with WhisperSTT
- [ ] **TODO:** Integrate with PiperTTS
- [ ] **TODO:** Audio queueing for outgoing speech

### 📋 Phase 3: Integration (Pending)

- [ ] Integrate with telegram-voice-service.py
- [ ] Add JSON-RPC methods (call.start, call.accept, call.hangup)
- [ ] Event broadcasting to Node.js gateway
- [ ] Configuration loading

### 📋 Phase 4: Testing (Pending)

- [ ] Test call establishment
- [ ] Test audio streaming
- [ ] Test STT during call
- [ ] Test TTS playback during call
- [ ] End-to-end call flow test

### 📋 Phase 5: Production Hardening (Pending)

- [ ] Error handling and recovery
- [ ] Call timeouts
- [ ] Reconnection logic
- [ ] Multiple call support
- [ ] Call quality monitoring

---

## Key Components

### 1. AiortcP2PCall Class

**Location:** `python/voice/aiortc-p2p-calls.py`

**Main Methods:**
```python
# Call control
await call.request_call(user_id)  # Initiate outgoing call
await call.hangup()               # End call

# Audio
await call.play_audio(audio_path) # Play TTS in call

# Status
call.get_status()                 # Get call state
```

**Events Emitted:**
- `call.ringing` - Call initiated, waiting for answer
- `call.connected` - Call established, audio active
- `call.speech` - Speech detected and transcribed
- `call.ended` - Call terminated

### 2. CallAudioTrack

Custom WebRTC audio track for bidirectional streaming:

```python
class CallAudioTrack(MediaStreamTrack):
    kind = "audio"

    async def recv(self):
        """Send audio to remote peer"""
        # Returns audio frames from queue or silence

    async def send_audio(self, audio_path):
        """Queue audio file for playback"""
```

### 3. Integration Points

**With Whisper STT:**
```python
async def _process_speech_segment(self, audio_buffer):
    # 1. Save audio buffer to WAV
    # 2. Call voice_service.transcribe(wav_path)
    # 3. Get text result
    # 4. Emit call.speech event
```

**With Piper TTS:**
```python
async def play_response(self, text):
    # 1. Call voice_service.synthesize(text)
    # 2. Get audio_path
    # 3. Queue for playback via audio_track
```

---

## Usage

### Basic Call Flow

```python
from aiortc_p2p_calls import AiortcP2PCall
from pyrogram import Client

# Initialize
client = Client("session", api_id=..., api_hash=...)
await client.start()

call = AiortcP2PCall(
    client=client,
    voice_service=voice_service,
    on_event=handle_event
)

# Make call
result = await call.request_call(user_id=123456789)
# {"status": "ringing", "call_id": 12345}

# Wait for call to connect
# Events: call.ringing → call.connected

# During call:
# - Incoming audio automatically processed via VAD + STT
# - call.speech events emitted with transcribed text

# Play TTS response
await call.play_audio("/tmp/response.wav")

# End call
await call.hangup()
```

### Event Handler

```python
async def handle_event(event_type: str, params: dict):
    if event_type == "call.connected":
        print(f"✅ Call connected: {params['call_id']}")

    elif event_type == "call.speech":
        text = params['text']
        print(f"🎤 User said: {text}")

        # Process with Claude, generate response
        response = await process_with_claude(text)

        # Generate TTS
        audio = await generate_tts(response)

        # Play in call
        await call.play_audio(audio)

    elif event_type == "call.ended":
        print(f"📴 Call ended: {params['duration']}s")
```

---

## Next Steps

### Immediate (This Week)

1. **Complete VAD implementation**
   - Improve silence detection
   - Tune thresholds for speech segmentation
   - Test with real audio

2. **Integrate STT/TTS**
   - Connect to existing WhisperSTT
   - Connect to existing PiperTTS
   - Test audio pipeline end-to-end

3. **Add to voice service**
   - Import AiortcP2PCall in telegram-voice-service.py
   - Create JSON-RPC methods
   - Handle events

### Medium Term (Next 2 Weeks)

4. **Testing**
   - Unit tests for call flow
   - Integration tests with real calls
   - Audio quality validation

5. **Production hardening**
   - Error recovery
   - Call timeouts
   - Network issue handling

6. **Documentation**
   - API documentation
   - Troubleshooting guide
   - Performance tuning

---

## Technical Details

### Audio Format

- **Sample Rate:** 48000 Hz (Telegram standard)
- **Channels:** 1 (Mono)
- **Codec:** Opus (WebRTC standard)
- **Frame Size:** 20ms chunks

### VAD (Voice Activity Detection)

Current implementation:
```python
# Simple amplitude-based VAD
amplitude = np.abs(samples).mean()
if amplitude < 500:  # Silence
    silence_duration += frame_duration
else:
    silence_duration = 0

# Process on 1.5s of silence
if silence_duration >= 1.5 and buffer:
    process_speech_segment(buffer)
```

**Improvements needed:**
- Use proper VAD library (webrtcvad or silero-vad)
- Adapt to background noise
- Better speech/non-speech classification

### WebRTC Connection

```python
# ICE servers from Telegram
ice_servers = [
    {
        'urls': ['stun:143.44.233.210:3478'],
    },
    {
        'urls': ['turn:143.44.233.210:3478'],
        'username': 'user123',
        'credential': 'pass456'
    }
]

# Create connection
pc = RTCPeerConnection(
    configuration=RTCConfiguration(
        iceServers=ice_servers
    )
)
```

### Telegram Signaling Flow

```
User A                 Telegram Server           User B
  │                           │                    │
  ├─► phone.RequestCall ─────►│                    │
  │   (g_a_hash)              │                    │
  │                           ├──► UpdatePhoneCall ┤
  │                           │    (PhoneCallWaiting)
  │                           │                    │
  │                           │◄─── phone.AcceptCall
  │                           │     (g_b)          │
  │◄── UpdatePhoneCall ───────┤                    │
  │   (PhoneCallAccepted)     │                    │
  │                           │                    │
  ├─► phone.ConfirmCall ─────►│                    │
  │   (g_a, key_fingerprint)  │                    │
  │                           ├──► UpdatePhoneCall ┤
  │◄── UpdatePhoneCall ───────┤    (PhoneCall)     │
  │   (PhoneCall)             │                    │
  │                           │                    │
  │◄────────── WebRTC Audio (P2P or via TURN) ───►│
```

---

## Troubleshooting

### Issue: "aiortc not found"

**Solution:**
```bash
pip install aiortc
# If fails, install system dependencies first (see Installation)
```

### Issue: "No audio in call"

**Checks:**
1. Verify ICE connection state: `pc.iceConnectionState` should be "connected"
2. Check audio track: `pc.getTransceivers()` should show audio
3. Verify Opus codec: Check `pc.getStats()` for codec info
4. Test audio file: Ensure input WAV is valid (48kHz, mono)

### Issue: "Call connects but no speech detected"

**Checks:**
1. VAD threshold too high/low
2. Incoming audio format mismatch
3. Check MediaRecorder output: Does WAV file contain audio?
4. Test Whisper separately with recorded file

### Issue: "High latency in responses"

**Optimizations:**
1. Reduce VAD silence timeout (1.5s → 1.0s)
2. Use faster Whisper model (medium → small)
3. Pre-generate common TTS responses
4. Stream TTS instead of waiting for full generation

---

## Performance Considerations

### Memory Usage

- **aiortc:** ~50-100 MB
- **Audio buffers:** ~10-20 MB
- **WebRTC overhead:** ~30 MB
- **Total:** ~100-150 MB per active call

### CPU Usage

- **WebRTC encoding/decoding:** 5-10% per call
- **Whisper STT:** Spike to 50-80% during transcription
- **Piper TTS:** 10-20% during synthesis
- **Baseline:** ~5% when call is idle (just audio streaming)

### Network Bandwidth

- **Opus @ 48kHz mono:** ~24-32 Kbps
- **With overhead:** ~40-50 Kbps bidirectional
- **Total:** ~100 Kbps per active call

---

## Comparison: aiortc vs tgcalls

| Aspect | tgcalls 3.0.0.dev6 | aiortc 1.9.0 |
|--------|-------------------|--------------|
| **Stability** | ❌ Crashes | ✅ Stable |
| **Language** | C++ bindings | Pure Python |
| **Debugging** | Difficult | Easy |
| **Documentation** | Limited | Excellent |
| **Maintenance** | ⚠️ Old | ✅ Active |
| **Control** | Limited | Full |
| **Complexity** | High | Medium |
| **Performance** | Better | Good enough |

---

## Future Enhancements

### Short Term
- [ ] Better VAD (webrtcvad or silero-vad)
- [ ] Audio resampling for non-48kHz sources
- [ ] Jitter buffer for network issues
- [ ] Echo cancellation

### Medium Term
- [ ] Video call support
- [ ] Screen sharing
- [ ] Call recording
- [ ] Call quality metrics

### Long Term
- [ ] Multi-party calls (mesh or SFU)
- [ ] Simulcast for bandwidth adaptation
- [ ] QUIC transport (when aiortc supports it)

---

## License & Credits

This implementation uses:
- **aiortc** - Python WebRTC library by Jeremy Lainé
- **Pyrogram** - Telegram MTProto client
- **PyAV** - FFmpeg bindings for Python

Based on Telegram's official protocol documentation:
- https://core.telegram.org/api/end-to-end/video-calls

---

**Last Updated:** 2026-02-01
**Status:** Phase 2 - Audio Pipeline Development
**Next Milestone:** Complete STT/TTS integration
