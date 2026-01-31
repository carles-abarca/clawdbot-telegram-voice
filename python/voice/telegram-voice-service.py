#!/usr/bin/env python3
"""
Telegram Voice Service for Clawdbot

Servei independent que gestiona:
- Notes de veu (STT/TTS)
- Trucades de veu P2P amb auto-answer

Exposa API JSON-RPC via Unix Socket (Linux) o TCP (macOS)
"""

import asyncio
import json
import os
import sys
import signal
import tempfile
import subprocess
import platform
import hashlib
import io
import wave
import struct
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, Union, List, Callable
from random import randint
import logging

# Pyrogram per MTProto
try:
    import pyrogram
    from pyrogram import Client
    from pyrogram.handlers import RawUpdateHandler
    from pyrogram.raw import functions, types
    PYROGRAM_AVAILABLE = True
except ImportError:
    PYROGRAM_AVAILABLE = False
    logging.warning("Pyrogram not available - calls disabled")

# tgcalls per WebRTC
try:
    import tgcalls
    TGCALLS_AVAILABLE = True
except ImportError:
    TGCALLS_AVAILABLE = False
    logging.warning("tgcalls not available - calls disabled")

# Configuració de logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger(__name__)

# Constants
SERVICE_NAME = "telegram-voice"
VERSION = "1.1.0"  # Updated with call support

# Paths segons plataforma
if platform.system() == "Linux":
    SOCKET_PATH = f"/run/user/{os.getuid()}/{SERVICE_NAME}.sock"
    TRANSPORT = "unix"
else:  # macOS
    SOCKET_PATH = None
    TCP_HOST = "127.0.0.1"
    TCP_PORT = 18790
    TRANSPORT = "tcp"

# Directori base
BASE_DIR = Path.home() / ".clawdbot" / "telegram-userbot"
CONFIG_PATH = BASE_DIR / "voice-service-config.json"
STATE_PATH = BASE_DIR / "conversation-state.json"
SESSION_PATH = BASE_DIR / "session"
TMP_DIR = Path(tempfile.gettempdir()) / "telegram-voice"


# ============================================================================
# HELPER FUNCTIONS (from pytgcalls helpers.py)
# ============================================================================

twoe1984 = 1 << 1984  # 2^1984

def i2b(value: int) -> bytes:
    """Convert integer value to bytes"""
    return int.to_bytes(
        value, length=(value.bit_length() + 8 - 1) // 8, byteorder='big', signed=False
    )

def b2i(value: bytes) -> int:
    """Convert bytes value to integer"""
    return int.from_bytes(value, 'big')

def check_g(g_x: int, p: int) -> None:
    """Check g_ numbers"""
    if not (1 < g_x < p - 1):
        raise ValueError('g_x is invalid (1 < g_x < p - 1 is false)')
    if not (twoe1984 < g_x < p - twoe1984):
        raise ValueError('g_x is invalid (2^1984 < g_x < p - 2^1984 is false)')

def calc_fingerprint(key: bytes) -> int:
    """Calculate key fingerprint"""
    return int.from_bytes(bytes(hashlib.sha1(key).digest()[-8:]), 'little', signed=True)

def generate_visualization(key: Union[bytes, int], part2: Union[bytes, int]) -> tuple:
    """Generate emoji visualization of key for verification"""
    emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
              '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙']
    
    if isinstance(key, int):
        key = i2b(key)
    if isinstance(part2, int):
        part2 = i2b(part2)

    visualization = []
    vis_src = hashlib.sha256(key + part2).digest()
    for i in range(0, len(vis_src), 8):
        number = vis_src[i:i + 8]
        idx = int.from_bytes(number, 'big') % len(emojis)
        visualization.append(emojis[idx])
    return visualization


# ============================================================================
# DH CONFIG CLASS
# ============================================================================

class DH:
    """Diffie-Hellman configuration"""
    def __init__(self, dhc):
        self.p = b2i(dhc.p)
        self.g = dhc.g
        self.resp = dhc

    def __repr__(self):
        return f'<DH p={self.p} g={self.g}>'


# ============================================================================
# CALL CLASSES (adapted from pytgcalls test.py)
# ============================================================================

class Call:
    """Base class for voice calls"""
    
    def __init__(self, client: 'Client', call_service: 'CallService'):
        if not client.is_connected:
            raise RuntimeError('Client must be started first')

        self.client = client
        self.call_service = call_service
        self.native_instance = None

        self.call = None
        self.call_access_hash = None
        self.peer = None
        self.call_peer = None
        self.state = None

        # Diffie-Hellman
        self.dhc = None
        self.a = None
        self.g_a = None
        self.g_a_hash = None
        self.b = None
        self.g_b = None
        self.g_b_hash = None
        self.auth_key = None
        self.key_fingerprint = None
        self.auth_key_visualization = None

        # Callbacks
        self.init_encrypted_handlers = []
        
        # Audio buffer for incoming audio
        self.audio_buffer = io.BytesIO()
        self.last_audio_time = None
        self.silence_threshold = 500
        self.silence_duration = 0
        self.max_silence = 1.5  # seconds
        
        # Start time for duration tracking
        self.start_time = None
        self.user_id = None
        self.user_name = None

        self._update_handler = RawUpdateHandler(self.process_update)
        self.client.add_handler(self._update_handler, -1)

    async def process_update(self, _, update, users, chats):
        """Handle Telegram updates"""
        if isinstance(update, types.UpdatePhoneCallSignalingData) and self.native_instance:
            log.debug('receiveSignalingData')
            self.native_instance.receiveSignalingData([x for x in update.data])

        if not isinstance(update, types.UpdatePhoneCall):
            raise pyrogram.ContinuePropagation

        call = update.phone_call
        if not self.call or not call or call.id != self.call.id:
            raise pyrogram.ContinuePropagation
        self.call = call

        if hasattr(call, 'access_hash') and call.access_hash:
            self.call_access_hash = call.access_hash
            self.call_peer = types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash)
            try:
                await self.received_call()
            except Exception as e:
                log.error(f"Error in received_call: {e}")

        if isinstance(call, types.PhoneCallDiscarded):
            self.call_discarded()
            raise pyrogram.StopPropagation

    @property
    def auth_key_bytes(self) -> bytes:
        return i2b(self.auth_key) if self.auth_key is not None else b''

    @property
    def call_id(self) -> int:
        return self.call.id if self.call else 0
    
    @property
    def duration(self) -> float:
        if self.start_time:
            return (datetime.now() - self.start_time).total_seconds()
        return 0

    @staticmethod
    def get_protocol():
        return types.PhoneCallProtocol(
            min_layer=92,
            max_layer=92,
            udp_p2p=True,
            udp_reflector=True,
            library_versions=['3.0.0'],
        )

    async def get_dhc(self):
        self.dhc = DH(await self.client.invoke(functions.messages.GetDhConfig(version=0, random_length=256)))
        return self.dhc

    def check_g(self, g_x: int, p: int) -> None:
        try:
            check_g(g_x, p)
        except RuntimeError:
            self.call_discarded()
            raise

    def stop(self) -> None:
        async def _():
            try:
                self.client.remove_handler(self._update_handler, -1)
            except ValueError:
                pass
        asyncio.ensure_future(_())

    def update_state(self, val) -> None:
        old_state = self.state
        self.state = val
        log.info(f"Call state: {old_state} -> {val}")

    def call_ended(self) -> None:
        self.update_state('ENDED')
        duration = self.duration
        self.stop()
        
        # Emit event
        if self.call_service:
            asyncio.create_task(self.call_service.emit_event('call.ended', {
                'call_id': str(self.call_id),
                'duration': duration,
                'reason': 'ended',
                'user_id': self.user_id,
                'user_name': self.user_name
            }))

    def call_failed(self, error=None) -> None:
        log.error(f'Call {self.call_id} failed with error: {error}')
        self.update_state('FAILED')
        self.stop()
        
        if self.call_service:
            asyncio.create_task(self.call_service.emit_event('call.ended', {
                'call_id': str(self.call_id),
                'duration': self.duration,
                'reason': 'failed',
                'error': str(error) if error else None
            }))

    def call_discarded(self):
        if self.call and isinstance(self.call.reason, types.PhoneCallDiscardReasonBusy):
            self.update_state('BUSY')
            self.stop()
            if self.call_service:
                asyncio.create_task(self.call_service.emit_event('call.ended', {
                    'call_id': str(self.call_id),
                    'reason': 'busy'
                }))
        else:
            self.call_ended()

    async def received_call(self):
        r = await self.client.invoke(
            functions.phone.ReceivedCall(peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash))
        )
        log.debug(f"ReceivedCall response: {r}")

    async def discard_call(self, reason=None):
        if not reason:
            reason = types.PhoneCallDiscardReasonDisconnect()
        try:
            await self.client.invoke(
                functions.phone.DiscardCall(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    duration=int(self.duration),
                    connection_id=0,
                    reason=reason,
                )
            )
            log.info(f"Discarded call {self.call_id}")
        except Exception as e:
            log.error(f"Error discarding call: {e}")

        self.call_ended()

    def signalling_data_emitted_callback(self, data):
        async def _():
            await self.client.invoke(
                functions.phone.SendSignalingData(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    data=bytes(data),
                )
            )
        asyncio.ensure_future(_())

    async def _initiate_encrypted_call(self) -> None:
        await self.client.invoke(functions.help.GetConfig())
        self.update_state('ESTABLISHED')
        self.start_time = datetime.now()
        self.auth_key_visualization = generate_visualization(self.auth_key, self.g_a)
        
        log.info(f"Call established! Visualization: {''.join(self.auth_key_visualization[:4])}")
        
        # Emit connected event
        if self.call_service:
            asyncio.create_task(self.call_service.emit_event('call.connected', {
                'call_id': str(self.call_id),
                'user_id': self.user_id,
                'user_name': self.user_name,
                'visualization': self.auth_key_visualization
            }))

        for handler in self.init_encrypted_handlers:
            if asyncio.iscoroutinefunction(handler):
                asyncio.ensure_future(handler(self))

    def on_init_encrypted_call(self, func: Callable) -> Callable:
        self.init_encrypted_handlers.append(func)
        return func


class IncomingCall(Call):
    """Handles incoming voice calls"""
    is_outgoing = False

    def __init__(self, call: 'types.PhoneCallRequested', client: 'Client', call_service: 'CallService'):
        super().__init__(client, call_service)
        self.update_state('WAITING_INCOMING')
        self.call = call
        self.call_access_hash = call.access_hash
        self.user_id = call.admin_id
        
    async def process_update(self, _, update, users, chats):
        await super().process_update(_, update, users, chats)
        if isinstance(self.call, types.PhoneCall) and not self.auth_key:
            await self.call_accepted()
            raise pyrogram.StopPropagation
        raise pyrogram.ContinuePropagation

    async def accept(self) -> bool:
        """Accept the incoming call"""
        self.update_state('EXCHANGING_KEYS')

        if not self.call:
            self.call_failed("Call object not set")
            return False

        if isinstance(self.call, types.PhoneCallDiscarded):
            log.warning('Call is already discarded')
            self.call_discarded()
            return False

        await self.get_dhc()
        self.b = randint(2, self.dhc.p - 1)
        self.g_b = pow(self.dhc.g, self.b, self.dhc.p)
        self.g_a_hash = self.call.g_a_hash

        try:
            self.call = (
                await self.client.invoke(
                    functions.phone.AcceptCall(
                        peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                        g_b=i2b(self.g_b),
                        protocol=self.get_protocol(),
                    )
                )
            ).phone_call
            log.info(f"Call {self.call_id} accepted")
        except Exception as e:
            log.error(f"Error accepting call: {e}")
            await self.discard_call()
            self.call_discarded()
            return False

        return True

    async def reject(self, reason=None) -> bool:
        """Reject the incoming call"""
        if not reason:
            reason = types.PhoneCallDiscardReasonBusy()
        await self.discard_call(reason)
        return True

    async def call_accepted(self) -> None:
        """Called when the other party confirms the call"""
        if not self.call.g_a_or_b:
            log.error('g_a is null')
            self.call_failed("g_a is null")
            return

        if self.g_a_hash != hashlib.sha256(self.call.g_a_or_b).digest():
            log.error("g_a_hash doesn't match")
            self.call_failed("g_a_hash mismatch")
            return

        self.g_a = b2i(self.call.g_a_or_b)
        self.check_g(self.g_a, self.dhc.p)
        self.auth_key = pow(self.g_a, self.b, self.dhc.p)
        self.key_fingerprint = calc_fingerprint(self.auth_key_bytes)

        if self.key_fingerprint != self.call.key_fingerprint:
            log.error("fingerprints don't match")
            self.call_failed("fingerprint mismatch")
            return

        await self._initiate_encrypted_call()


class OutgoingCall(Call):
    """Handles outgoing voice calls"""
    is_outgoing = True

    def __init__(self, client: 'Client', call_service: 'CallService', user_id: Union[int, str]):
        super().__init__(client, call_service)
        self.user_id = user_id

    async def request(self):
        """Initiate outgoing call"""
        self.update_state('REQUESTING')

        self.peer = await self.client.resolve_peer(self.user_id)

        await self.get_dhc()
        self.a = randint(2, self.dhc.p - 1)
        self.g_a = pow(self.dhc.g, self.a, self.dhc.p)
        self.g_a_hash = hashlib.sha256(i2b(self.g_a)).digest()

        self.call = (
            await self.client.invoke(
                functions.phone.RequestCall(
                    user_id=self.peer,
                    random_id=randint(0, 0x7FFFFFFF - 1),
                    g_a_hash=self.g_a_hash,
                    protocol=self.get_protocol(),
                )
            )
        ).phone_call

        self.update_state('WAITING')

    async def process_update(self, _, update, users, chats) -> None:
        await super().process_update(_, update, users, chats)

        if isinstance(self.call, types.PhoneCallAccepted) and not self.auth_key:
            await self.call_accepted()
            raise pyrogram.StopPropagation

        raise pyrogram.ContinuePropagation

    async def call_accepted(self) -> None:
        """Called when the other party accepts"""
        self.update_state('EXCHANGING_KEYS')

        await self.get_dhc()
        self.g_b = b2i(self.call.g_b)
        self.check_g(self.g_b, self.dhc.p)
        self.auth_key = pow(self.g_b, self.a, self.dhc.p)
        self.key_fingerprint = calc_fingerprint(self.auth_key_bytes)

        self.call = (
            await self.client.invoke(
                functions.phone.ConfirmCall(
                    key_fingerprint=self.key_fingerprint,
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    g_a=i2b(self.g_a),
                    protocol=self.get_protocol(),
                )
            )
        ).phone_call

        await self._initiate_encrypted_call()


# ============================================================================
# CALL SERVICE
# ============================================================================

class CallService:
    """Manages voice calls"""
    
    def __init__(self, config: Dict, voice_service: 'VoiceService'):
        self.config = config
        self.voice_service = voice_service
        self.client: Optional[Client] = None
        self.active_call: Optional[Call] = None
        self.event_handlers: List[Callable] = []
        
        # Call config
        call_config = config.get('calls', {})
        self.enabled = call_config.get('enabled', True)
        self.auto_answer = call_config.get('autoAnswer', True)
        self.auto_answer_delay = call_config.get('autoAnswerDelay', 1000) / 1000  # Convert to seconds
        self.max_duration = call_config.get('maxCallDuration', 300)
        self.greeting = call_config.get('greeting', "Hola! Sóc Jarvis, l'assistent de Carles.")
        self.goodbye = call_config.get('goodbye', "D'acord, fins aviat!")
        
        log.info(f"CallService initialized (enabled={self.enabled}, autoAnswer={self.auto_answer})")
    
    async def start(self):
        """Start the call service with Pyrogram client"""
        if not PYROGRAM_AVAILABLE or not TGCALLS_AVAILABLE:
            log.warning("Call service cannot start - missing dependencies")
            return False
        
        if not self.enabled:
            log.info("Call service disabled in config")
            return False
        
        # Check if session exists
        session_file = SESSION_PATH.with_suffix('.session')
        if not session_file.exists():
            log.warning(f"Session file not found: {session_file}")
            return False
        
        # Load API credentials from config
        api_id = self.config.get('apiId')
        api_hash = self.config.get('apiHash')
        
        if not api_id or not api_hash:
            log.warning("API credentials not found in config")
            return False
        
        try:
            self.client = Client(
                name=str(SESSION_PATH),
                api_id=api_id,
                api_hash=api_hash,
                no_updates=False
            )
            
            await self.client.start()
            log.info("Pyrogram client started for calls")
            
            # Add handler for incoming calls
            self.client.add_handler(RawUpdateHandler(self._handle_update), -1)
            
            return True
            
        except Exception as e:
            log.error(f"Failed to start call service: {e}")
            return False
    
    async def stop(self):
        """Stop the call service"""
        if self.active_call:
            await self.active_call.discard_call()
            self.active_call = None
        
        if self.client:
            await self.client.stop()
            self.client = None
    
    async def _handle_update(self, client, update, users, chats):
        """Handle raw updates from Telegram"""
        if isinstance(update, types.UpdatePhoneCall):
            call = update.phone_call
            
            if isinstance(call, types.PhoneCallRequested):
                # Incoming call!
                user_id = call.admin_id
                user_name = None
                
                # Try to get user name
                if user_id in users:
                    user = users[user_id]
                    user_name = user.first_name
                    if user.last_name:
                        user_name += f" {user.last_name}"
                
                log.info(f"📞 Incoming call from {user_name or user_id}")
                
                # Emit incoming event
                await self.emit_event('call.incoming', {
                    'user_id': user_id,
                    'user_name': user_name,
                    'call_id': str(call.id)
                })
                
                # Handle auto-answer
                if self.auto_answer and not self.active_call:
                    await asyncio.sleep(self.auto_answer_delay)
                    await self._accept_incoming_call(call, user_name)
        
        raise pyrogram.ContinuePropagation
    
    async def _accept_incoming_call(self, call_obj, user_name: Optional[str] = None):
        """Accept an incoming call"""
        try:
            incoming = IncomingCall(call_obj, self.client, self)
            incoming.user_name = user_name
            self.active_call = incoming
            
            success = await incoming.accept()
            if success:
                log.info(f"Call accepted from {user_name or incoming.user_id}")
                
                # Setup audio handling when call is established
                @incoming.on_init_encrypted_call
                async def on_call_established(call: IncomingCall):
                    await self._setup_call_audio(call)
                    
                    # Send greeting
                    if self.greeting:
                        await self._send_audio_response(self.greeting)
            else:
                self.active_call = None
                
        except Exception as e:
            log.error(f"Error accepting call: {e}")
            self.active_call = None
    
    async def _setup_call_audio(self, call: Call):
        """Setup WebRTC audio handling"""
        if not call.call or not call.call.connections:
            log.error("No connections available for call")
            return
        
        # Create RTC servers from connections
        rtc_servers = [
            tgcalls.RtcServer(
                c.ip, c.ipv6, c.port, 
                c.username, c.password, 
                c.turn, c.stun
            ) 
            for c in call.call.connections
        ]
        
        # Create native instance for WebRTC
        call.native_instance = tgcalls.NativeInstance()
        call.native_instance.setSignalingDataEmittedCallback(call.signalling_data_emitted_callback)
        
        # Start the call
        log.info(f"Starting WebRTC call (outgoing={call.is_outgoing})")
        call.native_instance.startCall(
            rtc_servers,
            [x for x in call.auth_key_bytes],
            call.is_outgoing,
            ""  # log path (empty = no logs)
        )
        
        # TODO: Setup audio frame callbacks for capturing incoming audio
        # This requires implementing audio device handling in tgcalls
        
        # Schedule max duration timeout
        if self.max_duration > 0:
            asyncio.create_task(self._call_timeout(call))
    
    async def _call_timeout(self, call: Call):
        """Handle max call duration"""
        await asyncio.sleep(self.max_duration)
        if self.active_call == call and call.state == 'ESTABLISHED':
            log.info(f"Call timeout after {self.max_duration}s")
            if self.goodbye:
                await self._send_audio_response(self.goodbye)
                await asyncio.sleep(3)  # Wait for goodbye to play
            await call.discard_call()
            self.active_call = None
    
    async def _send_audio_response(self, text: str):
        """Generate TTS and send to active call"""
        if not self.active_call or not self.voice_service:
            return
        
        try:
            # Generate audio with Piper
            result = await self.voice_service.synthesize(text)
            if 'error' not in result:
                audio_path = result['audio_path']
                # TODO: Send audio to WebRTC stream
                # This requires implementing audio streaming in the native instance
                log.info(f"Would send audio: {audio_path}")
        except Exception as e:
            log.error(f"Error sending audio response: {e}")
    
    def add_event_handler(self, handler: Callable):
        """Add handler for call events"""
        self.event_handlers.append(handler)
    
    async def emit_event(self, event_type: str, params: Dict):
        """Emit event to all handlers"""
        log.info(f"Call event: {event_type} - {params}")
        for handler in self.event_handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(event_type, params)
                else:
                    handler(event_type, params)
            except Exception as e:
                log.error(f"Error in event handler: {e}")
    
    # JSON-RPC methods
    
    async def accept(self) -> Dict:
        """Accept current incoming call"""
        if not self.active_call:
            return {"error": "No incoming call"}
        if self.active_call.state != 'WAITING_INCOMING':
            return {"error": f"Call not in waiting state: {self.active_call.state}"}
        
        success = await self.active_call.accept()
        return {"accepted": success, "call_id": str(self.active_call.call_id)}
    
    async def reject(self) -> Dict:
        """Reject current incoming call"""
        if not self.active_call:
            return {"error": "No incoming call"}
        
        await self.active_call.reject()
        self.active_call = None
        return {"rejected": True}
    
    async def hangup(self) -> Dict:
        """Hang up current call"""
        if not self.active_call:
            return {"error": "No active call"}
        
        duration = self.active_call.duration
        await self.active_call.discard_call()
        self.active_call = None
        return {"hungup": True, "duration": duration}
    
    async def status(self) -> Dict:
        """Get current call status"""
        if not self.active_call:
            return {
                "active": False,
                "service_enabled": self.enabled,
                "auto_answer": self.auto_answer
            }
        
        return {
            "active": True,
            "call_id": str(self.active_call.call_id),
            "state": self.active_call.state,
            "duration": self.active_call.duration,
            "user_id": self.active_call.user_id,
            "user_name": self.active_call.user_name,
            "is_outgoing": self.active_call.is_outgoing if hasattr(self.active_call, 'is_outgoing') else None
        }
    
    async def start_call(self, user_id: Union[int, str]) -> Dict:
        """Start an outgoing call"""
        if not self.client:
            return {"error": "Call service not started"}
        if self.active_call:
            return {"error": "Another call is active"}
        
        try:
            outgoing = OutgoingCall(self.client, self, user_id)
            self.active_call = outgoing
            await outgoing.request()
            
            @outgoing.on_init_encrypted_call
            async def on_call_established(call: OutgoingCall):
                await self._setup_call_audio(call)
            
            return {
                "started": True,
                "call_id": str(outgoing.call_id),
                "state": outgoing.state
            }
        except Exception as e:
            self.active_call = None
            return {"error": str(e)}


# ============================================================================
# CONVERSATION STATE
# ============================================================================

class ConversationState:
    """Gestiona l'estat d'idioma per conversa"""
    
    def __init__(self, state_path: Path):
        self.state_path = state_path
        self.state = self._load()
    
    def _load(self) -> Dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text())
            except:
                pass
        return {"users": {}, "defaults": {"language": "ca"}}
    
    def _save(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2))
    
    def get_language(self, user_id: str) -> str:
        return self.state["users"].get(str(user_id), {}).get(
            "language", self.state["defaults"]["language"]
        )
    
    def set_language(self, user_id: str, language: str):
        self.state["users"][str(user_id)] = {
            "language": language,
            "lastUpdated": datetime.now().isoformat()
        }
        self._save()
        log.info(f"Language for user {user_id} set to: {language}")


# ============================================================================
# VOICE SERVICE
# ============================================================================

class VoiceService:
    """Servei principal de veu"""
    
    SUPPORTED_LANGUAGES = {
        "ca": {"name": "Català", "whisper": "ca", "voice": "ca_ES-upc_pau-x_low.onnx"},
        "es": {"name": "Castellà", "whisper": "es", "voice": "es_ES-sharvard-medium.onnx"},
        "en": {"name": "English", "whisper": "en", "voice": "en_US-lessac-medium.onnx"},
    }
    
    def __init__(self, config: Dict):
        self.config = config
        self.state = ConversationState(STATE_PATH)
        self.tmp_dir = TMP_DIR
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        
        # Paths de les eines
        self.whisper_path = self._expand_path(config.get("whisperPath", ""))
        self.whisper_model = self._expand_path(config.get("modelPath", ""))
        self.piper_path = self._expand_path(config.get("piperPath", ""))
        self.voices_dir = self._expand_path(config.get("voicesDir", "~/piper/voices"))
        self.default_voice = self._expand_path(config.get("voicePath", ""))
        self.threads = config.get("threads", 4)
        self.length_scale = config.get("lengthScale", 0.60)
        
        log.info(f"VoiceService initialized")
        log.info(f"  Whisper: {self.whisper_path}")
        log.info(f"  Piper: {self.piper_path}")
        log.info(f"  Default language: {self.state.state['defaults']['language']}")
    
    def _expand_path(self, p: str) -> str:
        if not p:
            return ""
        return os.path.expanduser(os.path.expandvars(p))
    
    async def transcribe(self, audio_path: str, user_id: Optional[str] = None, force_language: Optional[str] = None) -> Dict:
        """Transcriu àudio a text amb detecció automàtica d'idioma"""
        
        log.info(f"Transcribing {audio_path} (auto-detect language)")
        
        # Convertir a WAV si cal
        wav_path = await self._ensure_wav(audio_path)
        
        # Executar Whisper SENSE forçar idioma (detecció automàtica)
        output_base = str(self.tmp_dir / f"transcript_{os.getpid()}")
        cmd = [
            self.whisper_path,
            "-m", self.whisper_model,
            "-f", wav_path,
            "-t", str(self.threads),
            "-otxt",
            "-of", output_base,
            "--no-timestamps",
            "--print-special"
        ]
        
        if force_language:
            lang_code = self.SUPPORTED_LANGUAGES.get(force_language, {}).get("whisper", force_language)
            cmd.extend(["-l", lang_code])
            log.info(f"  Forced language: {lang_code}")
        else:
            # IMPORTANT: sense -l, whisper assumeix anglès!
            cmd.extend(["-l", "auto"])
            log.info(f"  Language detection: auto")
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0:
                log.error(f"Whisper error: {stderr.decode()}")
                return {"error": "Transcription failed", "details": stderr.decode()}
            
            txt_path = output_base + ".txt"
            if os.path.exists(txt_path):
                text = Path(txt_path).read_text().strip()
                os.unlink(txt_path)
            else:
                text = stdout.decode().strip()
            
            detected_language = self._detect_language_from_output(stderr.decode(), text)
            log.info(f"  Detected language: {detected_language}")
            
            if user_id and detected_language:
                self.state.set_language(str(user_id), detected_language)
            
            return {
                "text": text,
                "language": detected_language,
                "audio_path": audio_path
            }
            
        except Exception as e:
            log.error(f"Transcription error: {e}")
            return {"error": str(e)}
    
    async def synthesize(self, text: str, user_id: Optional[str] = None) -> Dict:
        """Genera àudio des de text"""
        language = self.state.get_language(user_id) if user_id else "ca"
        voice_file = self.SUPPORTED_LANGUAGES.get(language, {}).get("voice")
        
        if voice_file:
            voice_path = os.path.join(self.voices_dir, voice_file)
        else:
            voice_path = self.default_voice
        
        log.info(f"Synthesizing text with voice={voice_path}")
        
        output_path = str(self.tmp_dir / f"tts_{os.getpid()}_{datetime.now().timestamp()}.wav")
        
        cmd = [
            self.piper_path,
            "--model", voice_path,
            "--output_file", output_path,
            "--length_scale", str(self.length_scale)
        ]
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "LD_LIBRARY_PATH": str(Path(self.piper_path).parent)}
            )
            stdout, stderr = await proc.communicate(input=text.encode())
            
            if proc.returncode != 0:
                log.error(f"Piper error: {stderr.decode()}")
                return {"error": "Synthesis failed", "details": stderr.decode()}
            
            # Add metadata to audio file for proper display in Telegram
            final_path = output_path.replace(".wav", "_meta.ogg")
            metadata_cmd = [
                "ffmpeg", "-y", "-i", output_path,
                "-metadata", "title=Jarvis Voice Message",
                "-metadata", "artist=Jarvis AI",
                "-c:a", "libopus",
                final_path
            ]
            try:
                meta_proc = await asyncio.create_subprocess_exec(
                    *metadata_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                await meta_proc.communicate()
                if meta_proc.returncode == 0:
                    os.remove(output_path)  # Remove original WAV
                    output_path = final_path
                    log.info(f"Added metadata to audio: {output_path}")
            except Exception as e:
                log.warning(f"Failed to add metadata (using original): {e}")
            
            return {
                "audio_path": output_path,
                "language": language,
                "text": text
            }
            
        except Exception as e:
            log.error(f"Synthesis error: {e}")
            return {"error": str(e)}
    
    async def set_language(self, user_id: str, language: str) -> Dict:
        """Canvia l'idioma per un usuari"""
        if language not in self.SUPPORTED_LANGUAGES:
            return {"error": f"Unsupported language: {language}. Supported: {list(self.SUPPORTED_LANGUAGES.keys())}"}
        
        self.state.set_language(user_id, language)
        return {
            "user_id": user_id,
            "language": language,
            "language_name": self.SUPPORTED_LANGUAGES[language]["name"]
        }
    
    async def get_language(self, user_id: str) -> Dict:
        """Obté l'idioma actual per un usuari"""
        language = self.state.get_language(user_id)
        return {
            "user_id": user_id,
            "language": language,
            "language_name": self.SUPPORTED_LANGUAGES.get(language, {}).get("name", language)
        }
    
    async def get_status(self) -> Dict:
        """Retorna l'estat del servei"""
        return {
            "service": SERVICE_NAME,
            "version": VERSION,
            "transport": TRANSPORT,
            "socket": SOCKET_PATH if TRANSPORT == "unix" else f"{TCP_HOST}:{TCP_PORT}",
            "whisper_available": os.path.exists(self.whisper_path),
            "piper_available": os.path.exists(self.piper_path),
            "pyrogram_available": PYROGRAM_AVAILABLE,
            "tgcalls_available": TGCALLS_AVAILABLE,
            "supported_languages": list(self.SUPPORTED_LANGUAGES.keys()),
            "default_language": self.state.state["defaults"]["language"],
            "active_users": len(self.state.state["users"])
        }
    
    def _detect_language_from_output(self, stderr: str, text: str) -> str:
        """Detecta l'idioma des de la sortida de Whisper o del text"""
        import re
        
        lang_match = re.search(r'auto-detected language[:\s]+(\w+)', stderr, re.IGNORECASE)
        if lang_match:
            detected = lang_match.group(1).lower()
            lang_map = {"spanish": "es", "catalan": "ca", "english": "en", 
                       "es": "es", "ca": "ca", "en": "en"}
            if detected in lang_map:
                return lang_map[detected]
        
        if text:
            text_lower = text.lower()
            spanish_markers = ["¿", "está", "estás", "qué", "cómo", "dónde", "cuándo", 
                             "tengo", "tienes", "tiene", "puedo", "puedes", "puede",
                             "quiero", "quieres", "necesito", "algún", "alguna"]
            catalan_markers = ["què", "com", "on", "quan", "tinc", "tens", "té",
                              "puc", "pots", "pot", "vull", "vols", "vol", 
                              "necessito", "algun", "alguna", "però", "això"]
            english_markers = ["the", "what", "how", "where", "when", "have", "has",
                              "can", "could", "want", "need", "some", "any"]
            
            spanish_count = sum(1 for m in spanish_markers if m in text_lower)
            catalan_count = sum(1 for m in catalan_markers if m in text_lower)
            english_count = sum(1 for m in english_markers if m in text_lower)
            
            if spanish_count > catalan_count and spanish_count > english_count:
                return "es"
            elif catalan_count > spanish_count and catalan_count > english_count:
                return "ca"
            elif english_count > 0:
                return "en"
        
        return "es"
    
    async def _ensure_wav(self, audio_path: str) -> str:
        """Converteix a WAV si cal (opus, ogg, etc.)"""
        if audio_path.endswith(".wav"):
            return audio_path
        
        wav_path = str(self.tmp_dir / f"converted_{os.getpid()}.wav")
        cmd = ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav_path]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        await proc.communicate()
        
        return wav_path if os.path.exists(wav_path) else audio_path


# ============================================================================
# JSON-RPC SERVER
# ============================================================================

class JSONRPCServer:
    """Servidor JSON-RPC"""
    
    def __init__(self, voice_service: VoiceService, call_service: Optional[CallService] = None):
        self.voice = voice_service
        self.call = call_service
        self.event_queue: asyncio.Queue = asyncio.Queue()
        self.clients: List[asyncio.StreamWriter] = []
        
        self.methods = {
            # Voice methods
            "transcribe": self._handle_transcribe,
            "synthesize": self._handle_synthesize,
            "language.set": self._handle_set_language,
            "language.get": self._handle_get_language,
            "status": self._handle_status,
            "health": self._handle_health,
            # Call methods
            "call.accept": self._handle_call_accept,
            "call.reject": self._handle_call_reject,
            "call.hangup": self._handle_call_hangup,
            "call.status": self._handle_call_status,
            "call.start": self._handle_call_start,
        }
        
        # Register for call events
        if call_service:
            call_service.add_event_handler(self._on_call_event)
    
    async def _on_call_event(self, event_type: str, params: Dict):
        """Handle call events and broadcast to clients"""
        notification = {
            "jsonrpc": "2.0",
            "method": event_type,
            "params": params
        }
        await self._broadcast(json.dumps(notification).encode())
    
    async def _broadcast(self, data: bytes):
        """Send data to all connected clients"""
        for writer in self.clients[:]:  # Copy list to avoid modification during iteration
            try:
                writer.write(len(data).to_bytes(4, 'big'))
                writer.write(data)
                await writer.drain()
            except Exception as e:
                log.error(f"Error broadcasting to client: {e}")
                self.clients.remove(writer)
    
    async def handle_request(self, data: bytes) -> bytes:
        """Processa una request JSON-RPC"""
        try:
            request = json.loads(data.decode())
        except json.JSONDecodeError:
            return self._error_response(None, -32700, "Parse error")
        
        if isinstance(request, list):
            responses = [await self._process_single(r) for r in request]
            return json.dumps(responses).encode()
        
        return await self._process_single(request)
    
    async def _process_single(self, request: Dict) -> bytes:
        """Processa una sola request"""
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})
        
        if method not in self.methods:
            return self._error_response(req_id, -32601, f"Method not found: {method}")
        
        try:
            result = await self.methods[method](params)
            return self._success_response(req_id, result)
        except Exception as e:
            log.error(f"Error handling {method}: {e}")
            return self._error_response(req_id, -32000, str(e))
    
    # Voice handlers
    async def _handle_transcribe(self, params: Dict) -> Dict:
        audio_path = params.get("audio_path")
        user_id = params.get("user_id")
        if not audio_path:
            raise ValueError("audio_path required")
        return await self.voice.transcribe(audio_path, user_id)
    
    async def _handle_synthesize(self, params: Dict) -> Dict:
        text = params.get("text")
        user_id = params.get("user_id")
        if not text:
            raise ValueError("text required")
        return await self.voice.synthesize(text, user_id)
    
    async def _handle_set_language(self, params: Dict) -> Dict:
        user_id = params.get("user_id")
        language = params.get("language")
        if not user_id or not language:
            raise ValueError("user_id and language required")
        return await self.voice.set_language(str(user_id), language)
    
    async def _handle_get_language(self, params: Dict) -> Dict:
        user_id = params.get("user_id")
        if not user_id:
            raise ValueError("user_id required")
        return await self.voice.get_language(str(user_id))
    
    async def _handle_status(self, params: Dict) -> Dict:
        status = await self.voice.get_status()
        if self.call:
            status['call'] = await self.call.status()
        return status
    
    async def _handle_health(self, params: Dict) -> Dict:
        return {"status": "ok", "timestamp": datetime.now().isoformat()}
    
    # Call handlers
    async def _handle_call_accept(self, params: Dict) -> Dict:
        if not self.call:
            return {"error": "Call service not available"}
        return await self.call.accept()
    
    async def _handle_call_reject(self, params: Dict) -> Dict:
        if not self.call:
            return {"error": "Call service not available"}
        return await self.call.reject()
    
    async def _handle_call_hangup(self, params: Dict) -> Dict:
        if not self.call:
            return {"error": "Call service not available"}
        return await self.call.hangup()
    
    async def _handle_call_status(self, params: Dict) -> Dict:
        if not self.call:
            return {"error": "Call service not available"}
        return await self.call.status()
    
    async def _handle_call_start(self, params: Dict) -> Dict:
        if not self.call:
            return {"error": "Call service not available"}
        user_id = params.get("user_id")
        if not user_id:
            raise ValueError("user_id required")
        return await self.call.start_call(user_id)
    
    def _success_response(self, req_id, result) -> bytes:
        return json.dumps({
            "jsonrpc": "2.0",
            "result": result,
            "id": req_id
        }).encode()
    
    def _error_response(self, req_id, code: int, message: str) -> bytes:
        return json.dumps({
            "jsonrpc": "2.0",
            "error": {"code": code, "message": message},
            "id": req_id
        }).encode()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: JSONRPCServer):
    """Gestiona una connexió de client"""
    addr = writer.get_extra_info('peername')
    log.info(f"Client connected: {addr}")
    server.clients.append(writer)
    
    try:
        while True:
            length_bytes = await reader.read(4)
            if not length_bytes:
                break
            
            length = int.from_bytes(length_bytes, 'big')
            if length > 10 * 1024 * 1024:  # Max 10MB
                log.warning(f"Message too large: {length}")
                break
            
            data = await reader.read(length)
            if not data:
                break
            
            response = await server.handle_request(data)
            
            writer.write(len(response).to_bytes(4, 'big'))
            writer.write(response)
            await writer.drain()
            
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log.error(f"Client error: {e}")
    finally:
        if writer in server.clients:
            server.clients.remove(writer)
        writer.close()
        await writer.wait_closed()
        log.info(f"Client disconnected: {addr}")


async def start_unix_server(server: JSONRPCServer):
    """Inicia servidor Unix socket (Linux)"""
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    
    srv = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, server),
        path=SOCKET_PATH
    )
    
    os.chmod(SOCKET_PATH, 0o600)
    
    log.info(f"🚀 Listening on Unix socket: {SOCKET_PATH}")
    return srv


async def start_tcp_server(server: JSONRPCServer):
    """Inicia servidor TCP (macOS)"""
    srv = await asyncio.start_server(
        lambda r, w: handle_client(r, w, server),
        host=TCP_HOST,
        port=TCP_PORT
    )
    
    log.info(f"🚀 Listening on TCP: {TCP_HOST}:{TCP_PORT}")
    return srv


def load_config() -> Dict:
    """Carrega configuració"""
    # Primer intentar carregar config específica del servei
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    
    # Sinó, llegir de la config de Clawdbot
    clawdbot_config = Path.home() / ".clawdbot" / "clawdbot.json"
    if clawdbot_config.exists():
        config = json.loads(clawdbot_config.read_text())
        userbot_config = config.get("channels", {}).get("telegram-userbot", {})
        return {
            **userbot_config.get("stt", {}),
            **userbot_config.get("tts", {}),
            "voicesDir": "~/piper/voices",
            "calls": userbot_config.get("calls", {}),
            "apiId": userbot_config.get("apiId"),
            "apiHash": userbot_config.get("apiHash"),
        }
    
    # Config per defecte
    return {
        "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
        "modelPath": "~/whisper.cpp/models/ggml-small.bin",
        "piperPath": "~/piper/piper/piper",
        "voicesDir": "~/piper/voices",
        "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
        "threads": 4,
        "lengthScale": 0.60,
        "calls": {
            "enabled": False,
            "autoAnswer": True,
            "autoAnswerDelay": 1000,
            "maxCallDuration": 300
        }
    }


async def main():
    """Entry point"""
    log.info(f"🎤 Telegram Voice Service v{VERSION}")
    log.info(f"   Platform: {platform.system()}")
    log.info(f"   Transport: {TRANSPORT}")
    log.info(f"   Pyrogram: {'✅' if PYROGRAM_AVAILABLE else '❌'}")
    log.info(f"   tgcalls: {'✅' if TGCALLS_AVAILABLE else '❌'}")
    
    # Carregar configuració
    config = load_config()
    
    # Inicialitzar servei de veu
    voice_service = VoiceService(config)
    
    # Inicialitzar servei de trucades (si disponible)
    call_service = None
    if PYROGRAM_AVAILABLE and TGCALLS_AVAILABLE:
        call_service = CallService(config, voice_service)
        started = await call_service.start()
        if started:
            log.info("📞 Call service started")
        else:
            log.warning("📞 Call service not started (check config/session)")
            call_service = None
    
    # Crear servidor JSON-RPC
    rpc_server = JSONRPCServer(voice_service, call_service)
    
    # Iniciar servidor segons plataforma
    if TRANSPORT == "unix":
        server = await start_unix_server(rpc_server)
    else:
        server = await start_tcp_server(rpc_server)
    
    # Gestionar senyals
    loop = asyncio.get_event_loop()
    
    async def shutdown_handler():
        log.info("👋 Shutting down...")
        if call_service:
            await call_service.stop()
        server.close()
        await server.wait_closed()
        if TRANSPORT == "unix" and os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
    
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown_handler()))
    
    # Córrer fins que s'aturi
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrupted")
