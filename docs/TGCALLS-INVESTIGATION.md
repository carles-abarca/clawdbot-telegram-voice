# Investigation: tgcalls v3.0.0.dev6 Segfault in NativeInstance.startCall()

**Date:** 2026-02-01
**Issue:** Segmentation fault when calling `NativeInstance.startCall()` in P2P voice calls
**Current Version:** tgcalls 3.0.0.dev6
**Status:** 🔴 Blocking P2P voice call audio

---

## Problem Summary

The signaling phase of P2P calls works perfectly (Diffie-Hellman key exchange, phone.RequestCall, phone.ConfirmCall), but the audio streaming fails with a segfault when attempting to initialize the WebRTC connection via `tgcalls.NativeInstance().startCall()`.

### Current Implementation

```python
# python/cli/telegram-call-cli.py:256
self.native_instance = tgcalls.NativeInstance(True, "")
self.native_instance.setSignalingDataEmittedCallback(self._on_signaling_data)

# Build server list
servers = [tgcalls.RtcServer(...) for c in connections]

# ❌ SEGFAULT HAPPENS HERE
self.native_instance.startCall(
    servers,
    auth_key_list,
    True,  # isOutgoing
    ""     # logPath
)
```

### Installed Version

```bash
$ pip list | grep tgcalls
tgcalls    3.0.0.dev6
```

**⚠️ This is a development version**, not a stable release.

---

## Root Cause Analysis

### 1. Development Version Instability

tgcalls 3.0.0.dev6 is an **unstable development build**. Development versions often have:
- Incomplete features
- Memory management issues
- API breaking changes
- Limited testing coverage

### 2. Architecture Mismatch

The current code is using **low-level tgcalls C++ bindings** directly, which is:
- More prone to crashes due to incorrect parameter types
- Harder to debug (crashes in C++ layer)
- Less maintained (community moved to higher-level wrappers)

### 3. Library Evolution

The Telegram calls ecosystem has evolved:

```
2019-2021: tgcalls (original Telegram C++ library)
            ↓
2022-2023: pytgcalls (Python wrapper around tgcalls)
            ↓
2024-2026: ntgcalls (modern C++ rewrite) + py-tgcalls (modern Python wrapper)
```

**The community has largely moved to ntgcalls + py-tgcalls**, which are actively maintained and stable.

---

## Recommended Solutions

### ✅ Solution 1: Migrate to py-tgcalls (RECOMMENDED)

**Why:** Modern, actively maintained, stable, high-level API

**Installation:**
```bash
pip install py-tgcalls -U
```

**Benefits:**
- Latest stable version: **2.2.10** (as of 2025)
- Uses ntgcalls 2.0.7 backend (released January 20, 2026)
- Supports Python 3.9-3.14 ✅ (we're on 3.12)
- Pre-built binaries for Linux x86_64
- High-level API that handles low-level details
- Active maintenance and bug fixes
- Works with Pyrogram, Telethon, and Hydrogram

**API Comparison:**

```python
# ❌ OLD: Direct tgcalls (crashes)
import tgcalls
native = tgcalls.NativeInstance(True, "")
native.startCall(servers, auth_key, True, "")

# ✅ NEW: py-tgcalls (stable)
from pytgcalls import PyTgCalls
from pytgcalls.types import Call

pytgcalls = PyTgCalls(client)
await pytgcalls.start()

# For P2P calls (private voice calls)
call = Call(
    user_id=user_id,
    outgoing=True
)
await pytgcalls.request_call(call)
```

**Migration Effort:** Medium (2-4 hours)
- Rewrite call handling code to use PyTgCalls API
- Simplifies code significantly (less boilerplate)
- Better error handling and stability

**Sources:**
- [py-tgcalls on PyPI](https://pypi.org/project/py-tgcalls/)
- [pytgcalls GitHub](https://github.com/pytgcalls/pytgcalls)
- [ntgcalls GitHub](https://github.com/pytgcalls/ntgcalls)

---

### ⚠️ Solution 2: Try Stable tgcalls Version (FALLBACK)

**Why:** Minimal code changes, but may still have issues

**Installation:**
```bash
# Uninstall dev version
pip uninstall tgcalls

# Try to install stable version (if available)
pip install tgcalls==2.0.0  # or latest stable
```

**Risks:**
- tgcalls stable versions may not support latest Telegram API changes
- Still using low-level bindings (crash-prone)
- May not have Python 3.12 support
- Project appears less maintained than py-tgcalls

**Migration Effort:** Low (0.5-1 hour)
- Just change version and test

---

### 🔧 Solution 3: Debug Current Implementation (NOT RECOMMENDED)

**Why:** For learning purposes only, not production-ready

**Steps:**
1. Enable tgcalls logging:
   ```python
   self.native_instance = tgcalls.NativeInstance(True, "/tmp/tgcalls.log")
   ```

2. Run with Python debugger:
   ```bash
   python -m pdb telegram-call-cli.py call 12345
   ```

3. Check for:
   - Invalid auth_key format (must be list of integers 0-255)
   - Invalid server parameters (missing fields)
   - Memory corruption (run with valgrind)

**Risks:**
- Time-consuming debugging C++ crashes
- May not lead to a fix (bug could be in tgcalls itself)
- Still on unstable dev version

**Migration Effort:** High (8+ hours with no guaranteed fix)

---

## Recommended Migration Path

### Phase 1: Install py-tgcalls (30 min)

```bash
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate

# Remove old tgcalls
pip uninstall -y tgcalls

# Install modern stack
pip install py-tgcalls -U

# Verify installation
python -c "from pytgcalls import PyTgCalls; print('✅ py-tgcalls installed')"
```

### Phase 2: Update Code (2-3 hours)

**File: `python/voice/telegram-voice-service.py`**

Replace the current Call classes with PyTgCalls integration:

```python
from pytgcalls import PyTgCalls
from pytgcalls.types import CallProtocol, CallProtocolType
from pytgcalls.exceptions import CallError

class VoiceService:
    def __init__(self, config):
        self.client = Client(...)
        self.pytgcalls = PyTgCalls(self.client)
        self.active_call = None

    async def start(self):
        await self.client.start()
        await self.pytgcalls.start()

        # Register handlers
        @self.pytgcalls.on_call_request()
        async def on_incoming_call(call):
            await self._handle_incoming_call(call)

        @self.pytgcalls.on_call_ended()
        async def on_call_ended(call):
            await self._handle_call_ended(call)

    async def start_call(self, user_id: int):
        """Start outgoing P2P call"""
        try:
            call = await self.pytgcalls.request_call(user_id)
            self.active_call = call

            # Emit event
            await self.emit_event({
                "method": "call.started",
                "params": {
                    "user_id": user_id,
                    "call_id": call.id
                }
            })

            return {"status": "ringing", "call_id": call.id}
        except CallError as e:
            return {"error": str(e)}

    async def accept_call(self, call_id: int):
        """Accept incoming call"""
        # PyTgCalls handles this automatically if auto_answer is set
        # Or manually: await self.pytgcalls.accept_call(call_id)
        pass

    async def hangup_call(self):
        """Hang up active call"""
        if self.active_call:
            await self.pytgcalls.leave_call(self.active_call.id)
            self.active_call = None
```

### Phase 3: Test (30 min)

```bash
# Test with CLI
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
python python/cli/telegram-call-cli.py call <user_id>
```

### Phase 4: Audio Streaming (Later - Phase 2 feature)

Once basic calls work, implement audio streaming:

```python
from pytgcalls.types import AudioStream

# Play audio file during call
stream = AudioStream(
    path="/path/to/audio.wav",
    bitrate=48000,
    sample_rate=48000
)
await pytgcalls.play(call.id, stream)

# Record audio from call
@pytgcalls.on_stream_end()
async def on_audio_chunk(call_id, chunk):
    # Process audio chunk with Whisper STT
    await process_audio(chunk)
```

---

## Alternative: Signaling-Only Approach

If audio streaming continues to be problematic, consider a **signaling-only** implementation:

### Concept

- Use the call infrastructure for **coordination** only
- Don't stream audio through the call
- Instead, use voice notes for audio exchange

### Flow

```
User initiates call
    ↓
Bot accepts (signaling works fine)
    ↓
Bot sends greeting voice note: "I'm listening..."
    ↓
User speaks → Telegram converts to voice note
    ↓
Bot transcribes with Whisper → responds with voice note
    ↓
Continue conversation via voice notes
    ↓
End call when done
```

### Benefits

- Avoids WebRTC audio streaming issues entirely
- Still provides a "call-like" UX (user sees active call)
- Leverages existing working voice note infrastructure
- No segfaults, all Python code

### Drawbacks

- Not true real-time audio (small delay for voice note upload/download)
- Less seamless than proper call audio
- Workaround rather than proper solution

---

## Comparison Matrix

| Solution | Effort | Stability | Features | Maintenance |
|----------|--------|-----------|----------|-------------|
| **py-tgcalls** | Medium | ⭐⭐⭐⭐⭐ | Full | Active ✅ |
| **Stable tgcalls** | Low | ⭐⭐⭐ | Limited | Declining |
| **Debug 3.0.0.dev6** | High | ⭐ | Unknown | N/A |
| **Signaling-only** | Low | ⭐⭐⭐⭐⭐ | Workaround | N/A |

---

## Decision

**Recommended: Migrate to py-tgcalls (Solution 1)**

### Rationale

1. **Stability:** Latest stable version (2.2.10) with active maintenance
2. **Modern:** Uses ntgcalls 2.0.7 backend (released January 2026)
3. **Support:** Python 3.12 fully supported
4. **Community:** Actively maintained, good documentation
5. **Future-proof:** The direction the ecosystem is moving
6. **Less code:** High-level API reduces boilerplate and crash potential

### Implementation Timeline

- **Phase 1 (Install):** 30 minutes
- **Phase 2 (Rewrite):** 2-3 hours
- **Phase 3 (Test):** 30 minutes
- **Phase 4 (Audio):** Future work (2-4 hours when ready)

**Total estimated effort:** 3-4 hours for basic P2P calls

---

## Next Steps

1. ✅ Document this investigation
2. ⏭️ Update `service/requirements.txt` to use py-tgcalls
3. ⏭️ Rewrite call handling in `telegram-voice-service.py`
4. ⏭️ Test with `telegram-call-cli.py`
5. ⏭️ Integrate with voice-client.ts JSON-RPC
6. ⏭️ Implement audio streaming (Phase 2)

---

## References

- [py-tgcalls on PyPI](https://pypi.org/project/py-tgcalls/)
- [pytgcalls GitHub Repository](https://github.com/pytgcalls/pytgcalls)
- [ntgcalls GitHub Repository](https://github.com/pytgcalls/ntgcalls)
- [PyTgCalls Documentation](https://pytgcalls.github.io/)
- [ntgcalls Latest Release v2.0.7](https://github.com/pytgcalls/ntgcalls/releases)

---

**Conclusion:** The segfault in tgcalls 3.0.0.dev6 is likely due to using an unstable development version with low-level bindings. The ecosystem has moved to py-tgcalls + ntgcalls, which provides a stable, high-level API. Migration is the recommended path forward.
