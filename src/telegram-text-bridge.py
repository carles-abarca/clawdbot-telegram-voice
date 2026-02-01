#!/usr/bin/env python3
"""
Telegram Text Bridge - Extended version with Phone Calls support
Handles text, media, location messages AND voice calls via Pyrogram
"""

import asyncio
import hashlib
import json
import os
import signal
import sys
from pathlib import Path
from random import randint
from typing import Union

from pyrogram import Client, filters, ContinuePropagation, StopPropagation
from pyrogram.handlers import RawUpdateHandler
from pyrogram.raw import functions, types
from pyrogram.types import Message
from pyrogram import errors

# Try to import aiortc for P2P calls (preferred, stable)
# Look in multiple locations for the module
_AIORTC_SEARCH_PATHS = [
    Path.home() / ".clawdbot" / "telegram-userbot",  # Production
    Path(__file__).parent,  # Same directory as bridge
    Path.home() / "jarvis" / "projects" / "clawdbot-telegram-userbot" / "src",  # Dev
]
for _p in _AIORTC_SEARCH_PATHS:
    if _p.exists() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

try:
    from aiortc_p2p_calls import AiortcP2PCall, AIORTC_AVAILABLE as _AIORTC_OK
    AIORTC_AVAILABLE = _AIORTC_OK
except ImportError:
    AIORTC_AVAILABLE = False
    print("WARNING: aiortc_p2p_calls not available", file=sys.stderr)

# Legacy tgcalls (deprecated, crashes)
try:
    import tgcalls
    TGCALLS_AVAILABLE = True
except ImportError:
    TGCALLS_AVAILABLE = False

# Prefer aiortc over tgcalls
CALLS_AVAILABLE = AIORTC_AVAILABLE or TGCALLS_AVAILABLE
if AIORTC_AVAILABLE:
    print("INFO: Using aiortc for P2P calls (stable)", file=sys.stderr)
elif TGCALLS_AVAILABLE:
    print("WARNING: Using legacy tgcalls (may crash)", file=sys.stderr)
else:
    print("WARNING: No call library available", file=sys.stderr)


# =====================================================
# Helper functions for crypto (from pytgcalls/helpers.py)
# =====================================================

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


# =====================================================
# Voice Service JSON-RPC Client
# =====================================================

class VoiceServiceClient:
    """Client to communicate with voice-service via Unix socket"""
    
    def __init__(self, socket_path: str = "/run/user/1000/tts-stt.sock"):
        self.socket_path = socket_path
        self._request_id = 0
        
    async def call(self, method: str, params: dict = None) -> dict:
        """Make a JSON-RPC call to voice-service"""
        try:
            reader, writer = await asyncio.open_unix_connection(self.socket_path)
            
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
                "params": params or {}
            }
            
            data = json.dumps(request) + "\n"
            writer.write(data.encode())
            await writer.drain()
            
            response_line = await asyncio.wait_for(reader.readline(), timeout=30.0)
            writer.close()
            await writer.wait_closed()
            
            if response_line:
                return json.loads(response_line.decode())
            return {"error": "Empty response"}
            
        except Exception as e:
            return {"error": str(e)}
    
    async def stt(self, audio_path: str) -> str:
        """Speech to text"""
        result = await self.call("stt", {"audio_path": audio_path})
        if "result" in result:
            return result["result"].get("text", "")
        return ""
    
    async def tts(self, text: str, output_path: str = None) -> str:
        """Text to speech, returns audio path"""
        params = {"text": text}
        if output_path:
            params["output_path"] = output_path
        result = await self.call("tts", params)
        if "result" in result:
            return result["result"].get("audio_path", "")
        return ""


# =====================================================
# Phone Call Classes (from pytgcalls)
# =====================================================

class DH:
    """Diffie-Hellman config"""
    def __init__(self, dhc: types.messages.DhConfig):
        self.p = b2i(dhc.p)
        self.g = dhc.g
        self.resp = dhc

    def __repr__(self):
        return f'<DH p={self.p} g={self.g}>'


class Call:
    """Base class for phone calls"""
    
    def __init__(self, client: Client, bridge: 'TelegramTextBridge'):
        if not client.is_connected:
            raise RuntimeError('Client must be started first')

        self.client = client
        self.bridge = bridge
        self.native_instance = None

        self.call = None
        self.call_access_hash = None
        self.peer = None
        self.call_peer = None
        self.state = None
        
        # Caller info
        self.caller_id = None
        self.caller_username = None
        self.caller_name = None

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

        self.init_encrypted_handlers = []
        
        # Audio handling
        self._audio_queue = asyncio.Queue()
        self._audio_task = None

    async def process_update(self, _, update, users, chats):
        if isinstance(update, types.UpdatePhoneCallSignalingData) and self.native_instance:
            self.native_instance.receiveSignalingData([x for x in update.data])

        if not isinstance(update, types.UpdatePhoneCall):
            raise ContinuePropagation

        call = update.phone_call
        if not self.call or not call or call.id != self.call.id:
            raise ContinuePropagation
        self.call = call

        if hasattr(call, 'access_hash') and call.access_hash:
            self.call_access_hash = call.access_hash
            self.call_peer = types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash)
            try:
                await self.received_call()
            except Exception as e:
                print(f"Error in received_call: {e}", file=sys.stderr)

        if isinstance(call, types.PhoneCallDiscarded):
            self.call_discarded()
            raise StopPropagation

    @property
    def auth_key_bytes(self) -> bytes:
        return i2b(self.auth_key) if self.auth_key is not None else b''

    @property
    def call_id(self) -> int:
        return self.call.id if self.call else 0

    @staticmethod
    def get_protocol() -> types.PhoneCallProtocol:
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
        if self._audio_task:
            self._audio_task.cancel()
        self.bridge._remove_call(self)

    def update_state(self, val: str) -> None:
        old_state = self.state
        self.state = val
        self.bridge.emit_event("call.state_changed", {
            "call_id": self.call_id,
            "state": val,
            "old_state": old_state,
            "caller_id": self.caller_id,
        })

    def call_ended(self) -> None:
        self.update_state('ENDED')
        self.stop()

    def call_failed(self, error=None) -> None:
        print(f'Call {self.call_id} failed with error {error}', file=sys.stderr)
        self.update_state('FAILED')
        self.stop()

    def call_discarded(self):
        if isinstance(self.call.reason, types.PhoneCallDiscardReasonBusy):
            self.update_state('BUSY')
            self.stop()
        else:
            self.call_ended()

    async def received_call(self):
        await self.client.invoke(
            functions.phone.ReceivedCall(peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash))
        )

    async def discard_call(self, reason=None):
        if not reason:
            reason = types.PhoneCallDiscardReasonDisconnect()
        try:
            await self.client.invoke(
                functions.phone.DiscardCall(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    duration=0,
                    connection_id=0,
                    reason=reason,
                )
            )
        except (errors.CallAlreadyDeclined, errors.CallAlreadyAccepted):
            pass
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

        for handler in self.init_encrypted_handlers:
            if asyncio.iscoroutinefunction(handler):
                asyncio.ensure_future(handler(self))

    def on_init_encrypted_call(self, func: callable) -> callable:
        self.init_encrypted_handlers.append(func)
        return func


class OutgoingCall(Call):
    """Outgoing call handler"""
    is_outgoing = True

    def __init__(self, client: Client, bridge: 'TelegramTextBridge', user_id: Union[int, str]):
        super().__init__(client, bridge)
        self.user_id = user_id

    async def request(self):
        self.update_state('REQUESTING')

        self.peer = await self.client.resolve_peer(self.user_id)
        
        # Store caller info (it's actually the callee for outgoing)
        self.caller_id = self.user_id

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
            raise StopPropagation

        raise ContinuePropagation

    async def call_accepted(self) -> None:
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
        await self._start_native_call()

    async def _start_native_call(self):
        """Start the native tgcalls instance"""
        if not TGCALLS_AVAILABLE:
            return
            
        self.native_instance = tgcalls.NativeInstance()
        self.native_instance.setSignalingDataEmittedCallback(self.signalling_data_emitted_callback)
        
        connections = self.call.connections if hasattr(self.call, 'connections') else []
        rtc_servers = [
            tgcalls.RtcServer(c.ip, c.ipv6, c.port, c.username, c.password, c.turn, c.stun) 
            for c in connections
        ]
        
        self.native_instance.startCall(
            rtc_servers, 
            [x for x in self.auth_key_bytes], 
            self.is_outgoing,
            ""  # log path
        )


class IncomingCall(Call):
    """Incoming call handler"""
    is_outgoing = False

    def __init__(self, call: types.PhoneCallRequested, client: Client, bridge: 'TelegramTextBridge'):
        super().__init__(client, bridge)
        self.call_accepted_handlers = []
        self.update_state('WAITING_INCOMING')
        self.call = call
        self.call_access_hash = call.access_hash
        
        # Store caller info
        self.caller_id = call.admin_id

    async def process_update(self, _, update, users, chats):
        await super().process_update(_, update, users, chats)
        if isinstance(self.call, types.PhoneCall) and not self.auth_key:
            await self.call_accepted()
            raise StopPropagation
        raise ContinuePropagation

    async def accept(self) -> bool:
        self.update_state('EXCHANGING_KEYS')

        if not self.call:
            self.call_failed()
            raise RuntimeError('call is not set')

        if isinstance(self.call, types.PhoneCallDiscarded):
            print('Call is already discarded', file=sys.stderr)
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
        except Exception as e:
            print(f"Error accepting call: {e}", file=sys.stderr)
            await self.discard_call()
            self.stop()
            self.call_discarded()
            return False

        return True

    async def call_accepted(self) -> None:
        if not self.call.g_a_or_b:
            print('g_a is null', file=sys.stderr)
            self.call_failed()
            return

        if self.g_a_hash != hashlib.sha256(self.call.g_a_or_b).digest():
            print('g_a_hash doesn\'t match', file=sys.stderr)
            self.call_failed()
            return

        self.g_a = b2i(self.call.g_a_or_b)
        self.check_g(self.g_a, self.dhc.p)
        self.auth_key = pow(self.g_a, self.b, self.dhc.p)
        self.key_fingerprint = calc_fingerprint(self.auth_key_bytes)

        if self.key_fingerprint != self.call.key_fingerprint:
            print('fingerprints don\'t match', file=sys.stderr)
            self.call_failed()
            return

        await self._initiate_encrypted_call()
        await self._start_native_call()

    async def _start_native_call(self):
        """Start the native tgcalls instance"""
        if not TGCALLS_AVAILABLE:
            return
            
        self.native_instance = tgcalls.NativeInstance()
        self.native_instance.setSignalingDataEmittedCallback(self.signalling_data_emitted_callback)
        
        connections = self.call.connections if hasattr(self.call, 'connections') else []
        rtc_servers = [
            tgcalls.RtcServer(c.ip, c.ipv6, c.port, c.username, c.password, c.turn, c.stun) 
            for c in connections
        ]
        
        self.native_instance.startCall(
            rtc_servers, 
            [x for x in self.auth_key_bytes], 
            self.is_outgoing,
            ""  # log path
        )


# =====================================================
# Main Bridge Class
# =====================================================

class TelegramTextBridge:
    def __init__(self, api_id: int, api_hash: str, session_path: str, allowed_users: list[int] = None):
        self.session_name = Path(session_path).stem
        self.workdir = str(Path(session_path).parent)
        self.allowed_users = allowed_users or []
        self.running = True
        self._shutdown_event = asyncio.Event()
        # Track active live locations by (user_id, message_id) to detect stops
        self._active_live_locations: dict[tuple[int, int], dict] = {}
        
        # Phone calls
        self._active_calls: dict[int, Call] = {}  # call_id -> Call (legacy)
        self._auto_answer = os.environ.get("AUTO_ANSWER_CALLS", "false").lower() == "true"
        
        # Voice service client (for STT/TTS)
        self.voice_client = VoiceServiceClient()
        
        # aiortc P2P call service (preferred)
        self._aiortc_call: 'AiortcP2PCall' = None  # Will be initialized after app.start()
        
        self.app = Client(
            self.session_name,
            api_id=api_id,
            api_hash=api_hash,
            workdir=self.workdir,
        )
        
        @self.app.on_message(filters.private & ~filters.me)
        async def message_handler(client: Client, message: Message):
            await self._handle_message(message)
        
        # Handler for edited messages (live location updates)
        @self.app.on_edited_message(filters.private & ~filters.me)
        async def edited_message_handler(client: Client, message: Message):
            await self._handle_edited_message(message)
        
        # Raw handler for phone calls
        self.app.add_handler(RawUpdateHandler(self._handle_raw_update), -1)
    
    def _remove_call(self, call: Call):
        """Remove a call from active calls"""
        if call.call_id in self._active_calls:
            del self._active_calls[call.call_id]
    
    async def _handle_raw_update(self, client: Client, update, users, chats):
        """Handle raw updates for phone calls"""
        # Forward signaling data to active calls
        if isinstance(update, types.UpdatePhoneCallSignalingData):
            for call in self._active_calls.values():
                if call.native_instance:
                    call.native_instance.receiveSignalingData([x for x in update.data])
        
        # Handle phone call updates
        if isinstance(update, types.UpdatePhoneCall):
            phone_call = update.phone_call
            
            # New incoming call
            if isinstance(phone_call, types.PhoneCallRequested):
                # Get caller info
                caller_id = phone_call.admin_id
                caller_info = users.get(caller_id, {})
                caller_username = getattr(caller_info, 'username', None)
                caller_name = getattr(caller_info, 'first_name', str(caller_id))
                
                # Check if caller is allowed
                if not self.is_user_allowed(caller_id):
                    self.emit_event("call.rejected", {
                        "call_id": phone_call.id,
                        "caller_id": caller_id,
                        "reason": "not_allowed"
                    })
                    raise ContinuePropagation
                
                # Create incoming call handler
                incoming_call = IncomingCall(phone_call, client, self)
                incoming_call.caller_id = caller_id
                incoming_call.caller_username = caller_username
                incoming_call.caller_name = caller_name
                
                # Register the call's update handler
                client.add_handler(RawUpdateHandler(incoming_call.process_update), -1)
                
                # Track the call
                self._active_calls[phone_call.id] = incoming_call
                
                # Emit incoming call event
                self.emit_event("call.incoming", {
                    "call_id": phone_call.id,
                    "caller_id": caller_id,
                    "caller_username": caller_username,
                    "caller_name": caller_name,
                    "auto_answer": self._auto_answer,
                })
                
                # Auto-answer if configured
                if self._auto_answer:
                    asyncio.create_task(self._auto_answer_call(incoming_call))
            
            # Forward to active call handlers
            for call_id, call in list(self._active_calls.items()):
                if hasattr(call, 'call') and call.call and call.call.id == phone_call.id:
                    # The call's own handler will process this
                    pass
        
        raise ContinuePropagation
    
    async def _auto_answer_call(self, call: IncomingCall):
        """Auto-answer an incoming call"""
        try:
            await asyncio.sleep(0.5)  # Brief delay
            await call.accept()
            self.emit_event("call.answered", {
                "call_id": call.call_id,
                "caller_id": call.caller_id,
            })
        except Exception as e:
            self.emit_event("call.error", {
                "call_id": call.call_id,
                "error": str(e),
            })
        
    async def _on_aiortc_event(self, event_type: str, params: dict):
        """Handle events from aiortc P2P call service"""
        # Map aiortc events to bridge events
        event_map = {
            "call.ringing": "call.ringing",
            "call.connected": "call.connected",
            "call.speech": "call.speech",
            "call.ended": "call.ended",
        }
        bridge_event = event_map.get(event_type, event_type)
        self.emit_event(bridge_event, params)
        
    def emit_event(self, event: str, data: dict):
        msg = json.dumps({"event": event, "data": data})
        print(f"EVENT:{msg}", flush=True)
        
    def send_response(self, request_id: str, success: bool, data: dict = None, error: str = None):
        response = {"id": request_id, "success": success, "data": data, "error": error}
        print(f"RESPONSE:{json.dumps(response)}", flush=True)

    def is_user_allowed(self, user_id: int) -> bool:
        if not self.allowed_users:
            return True
        return user_id in self.allowed_users
        
    async def handle_request(self, request: dict):
        req_id = request.get("id", "unknown")
        action = request.get("action")
        payload = request.get("payload", {})
        
        try:
            if action == "status":
                is_connected = False
                try:
                    is_connected = self.app.is_connected
                except:
                    pass
                self.send_response(req_id, True, {
                    "connected": is_connected,
                    "active_calls": len(self._active_calls),
                    "auto_answer": self._auto_answer,
                    "tgcalls_available": TGCALLS_AVAILABLE,
                })
                
            elif action == "send_text":
                user_id = payload.get("user_id")
                text = payload.get("text")
                if not user_id or not text:
                    self.send_response(req_id, False, error="user_id and text required")
                    return
                try:
                    await self.app.send_message(user_id, text)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            elif action == "send_voice":
                user_id = payload.get("user_id")
                audio_path = payload.get("audio_path")
                if not user_id or not audio_path:
                    self.send_response(req_id, False, error="user_id and audio_path required")
                    return
                if not os.path.exists(audio_path):
                    self.send_response(req_id, False, error=f"audio file not found: {audio_path}")
                    return
                try:
                    await self.app.send_voice(user_id, audio_path)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            elif action == "typing":
                user_id = payload.get("user_id")
                typing = payload.get("typing", True)
                if not user_id:
                    self.send_response(req_id, False, error="user_id required")
                    return
                try:
                    from pyrogram.enums import ChatAction
                    if typing:
                        await self.app.send_chat_action(user_id, ChatAction.TYPING)
                    else:
                        await self.app.send_chat_action(user_id, ChatAction.CANCEL)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
                    
            elif action == "mark_read":
                chat_id = payload.get("chat_id") or payload.get("user_id")
                if not chat_id:
                    self.send_response(req_id, False, error="chat_id or user_id required")
                    return
                try:
                    await self.app.read_chat_history(chat_id)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            elif action == "chat_action":
                user_id = payload.get("user_id")
                action_type = payload.get("action_type", "typing")
                if not user_id:
                    self.send_response(req_id, False, error="user_id required")
                    return
                try:
                    from pyrogram.enums import ChatAction
                    action_map = {
                        "typing": ChatAction.TYPING,
                        "upload_audio": ChatAction.UPLOAD_AUDIO,
                        "record_audio": ChatAction.RECORD_AUDIO,
                        "upload_video": ChatAction.UPLOAD_VIDEO,
                        "record_video": ChatAction.RECORD_VIDEO,
                        "upload_photo": ChatAction.UPLOAD_PHOTO,
                        "upload_document": ChatAction.UPLOAD_DOCUMENT,
                        "playing": ChatAction.PLAYING,
                        "choose_sticker": ChatAction.CHOOSE_STICKER,
                        "cancel": ChatAction.CANCEL,
                    }
                    chat_action = action_map.get(action_type, ChatAction.TYPING)
                    await self.app.send_chat_action(user_id, chat_action)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            elif action == "record_audio":
                user_id = payload.get("user_id")
                recording = payload.get("recording", True)
                if not user_id:
                    self.send_response(req_id, False, error="user_id required")
                    return
                try:
                    from pyrogram.enums import ChatAction
                    if recording:
                        await self.app.send_chat_action(user_id, ChatAction.RECORD_AUDIO)
                    else:
                        await self.app.send_chat_action(user_id, ChatAction.CANCEL)
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            # =====================================================
            # Phone Call Actions
            # =====================================================
            
            elif action == "call.start":
                user_id = payload.get("user_id")
                if not user_id:
                    self.send_response(req_id, False, error="user_id required")
                    return
                
                # Use aiortc if available (preferred)
                if self._aiortc_call:
                    try:
                        result = await self._aiortc_call.request_call(user_id)
                        if "error" in result:
                            self.send_response(req_id, False, error=result["error"])
                        else:
                            self.send_response(req_id, True, {"call_id": result.get("call_id"), "status": result.get("status")})
                    except Exception as e:
                        self.send_response(req_id, False, error=str(e))
                # Fallback to legacy tgcalls
                elif TGCALLS_AVAILABLE:
                    try:
                        call = OutgoingCall(self.app, self, user_id)
                        self.app.add_handler(RawUpdateHandler(call.process_update), -1)
                        await call.request()
                        self._active_calls[call.call_id] = call
                        self.send_response(req_id, True, {"call_id": call.call_id})
                    except Exception as e:
                        self.send_response(req_id, False, error=str(e))
                else:
                    self.send_response(req_id, False, error="No call library available")
            
            elif action == "call.answer":
                call_id = payload.get("call_id")
                if not call_id:
                    # Answer the first pending incoming call
                    for cid, call in self._active_calls.items():
                        if isinstance(call, IncomingCall) and call.state == "WAITING_INCOMING":
                            call_id = cid
                            break
                
                if not call_id or call_id not in self._active_calls:
                    self.send_response(req_id, False, error="No pending incoming call")
                    return
                
                call = self._active_calls[call_id]
                if not isinstance(call, IncomingCall):
                    self.send_response(req_id, False, error="Not an incoming call")
                    return
                
                try:
                    await call.accept()
                    self.send_response(req_id, True, {"call_id": call_id})
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
            elif action == "call.hangup":
                # Use aiortc if available and has active call
                if self._aiortc_call and self._aiortc_call.state.state != "IDLE":
                    try:
                        result = await self._aiortc_call.hangup()
                        self.send_response(req_id, True, result)
                    except Exception as e:
                        self.send_response(req_id, False, error=str(e))
                # Fallback to legacy tgcalls
                elif self._active_calls:
                    call_id = payload.get("call_id")
                    if not call_id:
                        call_id = next(iter(self._active_calls.keys()))
                    
                    if call_id not in self._active_calls:
                        self.send_response(req_id, False, error="No active call")
                        return
                    
                    call = self._active_calls[call_id]
                    try:
                        await call.discard_call()
                        self.send_response(req_id, True, {"call_id": call_id})
                    except Exception as e:
                        self.send_response(req_id, False, error=str(e))
                else:
                    self.send_response(req_id, False, error="No active call")
            
            elif action == "call.status":
                # Check aiortc first
                if self._aiortc_call:
                    status = self._aiortc_call.get_status()
                    self.send_response(req_id, True, status)
                elif self._active_calls:
                    call_id = payload.get("call_id")
                    if call_id and call_id in self._active_calls:
                        call = self._active_calls[call_id]
                        self.send_response(req_id, True, {
                            "call_id": call_id,
                            "state": call.state,
                            "caller_id": call.caller_id,
                            "is_outgoing": call.is_outgoing,
                        })
                    else:
                        calls_info = []
                        for cid, call in self._active_calls.items():
                            calls_info.append({
                                "call_id": cid,
                                "state": call.state,
                                "caller_id": call.caller_id,
                                "is_outgoing": call.is_outgoing,
                            })
                        self.send_response(req_id, True, {"calls": calls_info, "active": bool(calls_info)})
                else:
                    self.send_response(req_id, True, {"active": False, "state": "IDLE"})
            
            elif action == "call.speak":
                # Speak text in active call (TTS + playback)
                text = payload.get("text")
                if not text:
                    self.send_response(req_id, False, error="text required")
                    return
                if self._aiortc_call and self._aiortc_call.state.state == "ACTIVE":
                    try:
                        result = await self._aiortc_call.speak_text(text)
                        self.send_response(req_id, True, result)
                    except Exception as e:
                        self.send_response(req_id, False, error=str(e))
                else:
                    self.send_response(req_id, False, error="No active call")
            
            elif action == "call.set_auto_answer":
                self._auto_answer = payload.get("enabled", False)
                self.send_response(req_id, True, {"auto_answer": self._auto_answer})
            
            elif action == "shutdown":
                # Hangup all calls first
                for call in list(self._active_calls.values()):
                    try:
                        await call.discard_call()
                    except:
                        pass
                
                self.running = False
                self._shutdown_event.set()
                self.send_response(req_id, True)
                
            else:
                self.send_response(req_id, False, error=f"unknown action: {action}")
                
        except Exception as e:
            self.send_response(req_id, False, error=str(e))
            
    async def stdin_reader(self):
        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        
        while self.running:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=1.0)
                if not line:
                    continue
                line = line.decode().strip()
                if line.startswith("REQUEST:"):
                    request = json.loads(line[8:])
                    await self.handle_request(request)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.emit_event("error", {"message": str(e)})

    async def _handle_edited_message(self, message: Message):
        """Handle edited messages - primarily for live location updates"""
        user_id = message.from_user.id if message.from_user else None
        
        if not user_id or not self.is_user_allowed(user_id):
            return
        
        key = (user_id, message.id)
        
        # Check if this message HAD a live location but now doesn't
        if not message.location and key in self._active_live_locations:
            # Live location was stopped!
            last_data = self._active_live_locations.pop(key)
            event_data = {
                "user_id": user_id,
                "username": message.from_user.username,
                "first_name": message.from_user.first_name,
                "message_id": message.id,
                "last_location": last_data.get("location"),
                "text": "🛑 Live location stopped",
            }
            self.emit_event("message.location_stop", event_data)
            return
        
        # Process location updates
        if message.location:
            loc = message.location
            live_period = getattr(loc, 'live_period', None)
            
            event_data = {
                "user_id": user_id,
                "username": message.from_user.username,
                "first_name": message.from_user.first_name,
                "message_id": message.id,
                "is_update": True,  # Flag to indicate this is an update, not initial
                "location": {
                    "latitude": loc.latitude,
                    "longitude": loc.longitude,
                    "live_period": live_period,
                    "heading": getattr(loc, 'heading', None),
                    "horizontal_accuracy": getattr(loc, 'horizontal_accuracy', None),
                },
                "text": f"🛰 Live location update: {loc.latitude}, {loc.longitude}",
            }
            
            # Track this as an active live location
            self._active_live_locations[key] = event_data
            
            self.emit_event("message.location_update", event_data)
                
    async def _handle_message(self, message: Message):
        user_id = message.from_user.id if message.from_user else None
        
        if not user_id or not self.is_user_allowed(user_id):
            return
        
        event_data = {
            "user_id": user_id,
            "username": message.from_user.username,
            "first_name": message.from_user.first_name,
            "text": message.text or message.caption or "",
            "message_id": message.id,
            "media_path": None,
            "media_type": None,
            "voice_path": None,
            "duration": None,
        }
        
        # Handle voice messages
        if message.voice:
            voice_path = f"/tmp/voice_{user_id}_{message.id}.ogg"
            await message.download(voice_path)
            event_data["voice_path"] = voice_path
            event_data["duration"] = message.voice.duration
            self.emit_event("message.voice", event_data)
        # Handle photos
        elif message.photo:
            photo_path = f"/tmp/photo_{user_id}_{message.id}.jpg"
            await message.download(photo_path)
            event_data["media_path"] = photo_path
            event_data["media_type"] = "photo"
            self.emit_event("message.media", event_data)
        # Handle documents
        elif message.document:
            doc = message.document
            ext = doc.file_name.split(".")[-1] if doc.file_name and "." in doc.file_name else "bin"
            doc_path = f"/tmp/doc_{user_id}_{message.id}.{ext}"
            await message.download(doc_path)
            event_data["media_path"] = doc_path
            event_data["media_type"] = "document"
            event_data["file_name"] = doc.file_name
            event_data["mime_type"] = doc.mime_type
            self.emit_event("message.media", event_data)
        # Handle videos
        elif message.video:
            video_path = f"/tmp/video_{user_id}_{message.id}.mp4"
            await message.download(video_path)
            event_data["media_path"] = video_path
            event_data["media_type"] = "video"
            event_data["duration"] = message.video.duration
            self.emit_event("message.media", event_data)
        # Handle stickers
        elif message.sticker:
            sticker = message.sticker
            ext = "webp" if not sticker.is_animated else "tgs"
            sticker_path = f"/tmp/sticker_{user_id}_{message.id}.{ext}"
            await message.download(sticker_path)
            event_data["media_path"] = sticker_path
            event_data["media_type"] = "sticker"
            event_data["emoji"] = sticker.emoji
            self.emit_event("message.media", event_data)
        # Handle audio files
        elif message.audio:
            audio_path = f"/tmp/audio_{user_id}_{message.id}.mp3"
            await message.download(audio_path)
            event_data["media_path"] = audio_path
            event_data["media_type"] = "audio"
            event_data["duration"] = message.audio.duration
            self.emit_event("message.media", event_data)
        # Handle location (static pin or live)
        elif message.location:
            loc = message.location
            live_period = getattr(loc, 'live_period', None)
            
            event_data["location"] = {
                "latitude": loc.latitude,
                "longitude": loc.longitude,
                "live_period": live_period,  # None = static, int = live (seconds)
                "heading": getattr(loc, 'heading', None),
                "horizontal_accuracy": getattr(loc, 'horizontal_accuracy', None),
            }
            
            if live_period:
                event_data["text"] = f"🛰 Live location ({live_period}s): {loc.latitude}, {loc.longitude}"
            else:
                event_data["text"] = f"📍 Location: {loc.latitude}, {loc.longitude}"
            
            self.emit_event("message.location", event_data)
        # Handle venue (location with name/address)
        elif message.venue:
            venue = message.venue
            event_data["location"] = {
                "latitude": venue.location.latitude,
                "longitude": venue.location.longitude,
                "title": venue.title,
                "address": venue.address,
                "foursquare_id": getattr(venue, 'foursquare_id', None),
            }
            event_data["text"] = f"📍 {venue.title} — {venue.address} ({venue.location.latitude}, {venue.location.longitude})"
            self.emit_event("message.location", event_data)
        # Plain text
        else:
            self.emit_event("message.private", event_data)
                
    async def run(self):
        def signal_handler(sig, frame):
            self.running = False
            self._shutdown_event.set()
            
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        try:
            await self.app.start()
            me = await self.app.get_me()
            
            # Initialize aiortc P2P call service if available
            if AIORTC_AVAILABLE:
                try:
                    self._aiortc_call = AiortcP2PCall(
                        client=self.app,
                        voice_service=self.voice_client,
                        on_event=self._on_aiortc_event
                    )
                    print("INFO: aiortc P2P call service initialized", file=sys.stderr)
                except Exception as e:
                    print(f"WARNING: Failed to initialize aiortc: {e}", file=sys.stderr)
                    self._aiortc_call = None
            
            self.emit_event("ready", {
                "user_id": me.id, 
                "username": me.username, 
                "name": me.first_name,
                "aiortc_available": self._aiortc_call is not None,
                "tgcalls_available": TGCALLS_AVAILABLE,
                "auto_answer": self._auto_answer,
            })
            
            reader_task = asyncio.create_task(self.stdin_reader())
            
            while self.running and not self._shutdown_event.is_set():
                await asyncio.sleep(0.1)
            
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass
                
        except Exception as e:
            self.emit_event("error", {"message": str(e), "fatal": True})
            raise
        finally:
            # Cleanup calls
            for call in list(self._active_calls.values()):
                try:
                    await call.discard_call()
                except:
                    pass
            
            try:
                await self.app.stop()
            except:
                pass
            self.emit_event("shutdown", {"status": "complete"})


def main():
    if len(sys.argv) < 4:
        print("Usage: bridge.py <api_id> <api_hash> <session_path> [allowed_users]", file=sys.stderr)
        sys.exit(1)
        
    api_id = int(sys.argv[1])
    api_hash = sys.argv[2]
    session_path = sys.argv[3]
    
    allowed_users = []
    if len(sys.argv) > 4:
        try:
            allowed_users = [int(u) for u in sys.argv[4].split(",") if u.strip()]
        except:
            pass
    
    bridge = TelegramTextBridge(api_id, api_hash, session_path, allowed_users)
    bridge.app.run(bridge.run())


if __name__ == "__main__":
    main()
