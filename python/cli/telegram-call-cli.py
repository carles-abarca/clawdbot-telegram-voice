#!/usr/bin/env python3
"""
Telegram Call CLI - Test client for voice calls

Usage:
  telegram-call-cli.py call <user_id>     # Initiate a call
  telegram-call-cli.py hangup             # Hang up current call
  telegram-call-cli.py status             # Show call status
"""

import asyncio
import argparse
import json
import os
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

try:
    from pyrogram import Client
    from pyrogram.raw import functions, types
    from pyrogram.handlers import RawUpdateHandler
    PYROGRAM_AVAILABLE = True
except ImportError:
    PYROGRAM_AVAILABLE = False
    print("ERROR: pyrogram not available", file=sys.stderr)
    sys.exit(1)

try:
    import tgcalls
    TGCALLS_AVAILABLE = True
except ImportError:
    TGCALLS_AVAILABLE = False
    print("WARNING: tgcalls not available, call audio may not work", file=sys.stderr)


# =====================================================
# Configuration
# =====================================================

BASE_DIR = Path.home() / ".clawdbot" / "telegram-userbot"
CONFIG_PATH = BASE_DIR / "voice-service-config.json"
SESSION_PATH = BASE_DIR / "session-call"  # Separate session for CLI calls

# Load config
def load_config():
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


# =====================================================
# Crypto helpers (from pytgcalls)
# =====================================================

twoe1984 = 1 << 1984

def i2b(value: int) -> bytes:
    return int.to_bytes(value, length=(value.bit_length() + 8 - 1) // 8, byteorder='big', signed=False)

def b2i(value: bytes) -> int:
    return int.from_bytes(value, 'big')

def check_g(g_x: int, p: int) -> None:
    if not (1 < g_x < p - 1):
        raise ValueError('g_x is invalid')
    if not (twoe1984 < g_x < p - twoe1984):
        raise ValueError('g_x is invalid')

def calc_fingerprint(key: bytes) -> int:
    return int.from_bytes(key[12:20], 'little', signed=True)


# =====================================================
# Call class
# =====================================================

class OutgoingCall:
    def __init__(self, client: Client, user_id: int):
        self.client = client
        self.user_id = user_id
        self.call = None
        self.call_access_hash = None
        self.state = "IDLE"
        self.g_a = None
        self.g_a_hash = None
        self.private_key = None
        self.auth_key = None
        self.key_fingerprint = None
        self.native_instance = None
        
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
            library_versions=['6.0.0', '5.0.0', '4.0.0']
        )
    
    async def request(self):
        """Request the call"""
        from random import randint
        import hashlib
        
        self.state = "REQUESTING"
        print(f"📞 Requesting call to user {self.user_id}...")
        
        # Get DH config from Telegram first
        dh_config = await self.client.invoke(
            functions.messages.GetDhConfig(version=0, random_length=256)
        )
        
        p = b2i(dh_config.p)
        g = dh_config.g
        
        # Generate private key within valid range (like the bridge does)
        self.private_key = randint(2, p - 1)
        
        # Calculate g_a
        self.g_a = pow(g, self.private_key, p)
        check_g(self.g_a, p)
        g_a_bytes = i2b(self.g_a)
        
        # Hash for verification
        self.g_a_hash = hashlib.sha256(g_a_bytes).digest()
        
        # Request the call
        try:
            peer = await self.client.resolve_peer(self.user_id)
            result = await self.client.invoke(
                functions.phone.RequestCall(
                    user_id=peer,
                    random_id=randint(0, 0x7FFFFFFF - 1),  # 31-bit signed int
                    g_a_hash=self.g_a_hash,
                    protocol=self.get_protocol()
                )
            )
            
            self.call = result.phone_call
            self.call_access_hash = self.call.access_hash
            self.state = "WAITING"
            print(f"📱 Call initiated! ID: {self.call_id}")
            print(f"📲 Waiting for answer...")
            return True
            
        except Exception as e:
            self.state = "FAILED"
            print(f"❌ Failed to request call: {e}", file=sys.stderr)
            return False
    
    async def process_update(self, client, update, users, chats):
        """Process call updates"""
        # Debug: show all updates
        print(f"📨 Update: {type(update).__name__}", flush=True)
        
        if not isinstance(update, types.UpdatePhoneCall):
            return
        
        call = update.phone_call
        print(f"📞 Call update: {type(call).__name__} (id={call.id})", flush=True)
        
        if not self.call or call.id != self.call.id:
            print(f"⚠️ Ignoring call update (not our call)", flush=True)
            return
        
        self.call = call
        
        if hasattr(call, 'access_hash') and call.access_hash:
            self.call_access_hash = call.access_hash
        
        # Call accepted
        if isinstance(call, types.PhoneCallAccepted):
            print("✅ Call accepted! Confirming...")
            await self._confirm_call(call)
        
        # Call confirmed/active
        elif isinstance(call, types.PhoneCall):
            print("🎤 Call is now active!")
            self.state = "ACTIVE"
            await self._setup_native(call)
        
        # Call ended
        elif isinstance(call, types.PhoneCallDiscarded):
            reason = call.reason
            if isinstance(reason, types.PhoneCallDiscardReasonBusy):
                print("📵 User is busy")
            elif isinstance(reason, types.PhoneCallDiscardReasonMissed):
                print("📵 Call was missed")
            elif isinstance(reason, types.PhoneCallDiscardReasonHangup):
                print("📴 Call ended")
            else:
                print(f"📴 Call discarded: {reason}")
            self.state = "ENDED"
    
    async def _confirm_call(self, call):
        """Confirm the call after acceptance"""
        try:
            # Get g_b from the accepted call
            g_b = b2i(call.g_b)
            
            # Load DH config
            dh_config = await self.client.invoke(
                functions.messages.GetDhConfig(version=0, random_length=256)
            )
            p = b2i(dh_config.p)
            
            check_g(g_b, p)
            
            # Calculate auth key
            self.auth_key = pow(g_b, self.private_key, p).to_bytes(256, 'big')
            self.key_fingerprint = calc_fingerprint(self.auth_key)
            
            # Confirm the call
            result = await self.client.invoke(
                functions.phone.ConfirmCall(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    g_a=i2b(self.g_a),
                    key_fingerprint=self.key_fingerprint,
                    protocol=self.get_protocol()
                )
            )
            
            self.call = result.phone_call
            self.state = "CONFIRMED"
            print("✅ Call confirmed!", flush=True)
            
            # Start native call immediately after confirming!
            await self._setup_native(self.call)
            
        except Exception as e:
            print(f"❌ Failed to confirm call: {e}", file=sys.stderr)
            self.state = "FAILED"
    
    async def _setup_native(self, call):
        """Setup native tgcalls instance"""
        if not TGCALLS_AVAILABLE:
            print("⚠️ tgcalls not available, audio won't work", flush=True)
            return
        
        try:
            # Get connection info
            connections = call.connections if hasattr(call, 'connections') else []
            print(f"🔌 Setting up WebRTC with {len(connections)} servers...", flush=True)
            
            # Create tgcalls instance
            # NativeInstance(outgoing: bool, logPath: str)
            self.native_instance = tgcalls.NativeInstance(True, "")
            self.native_instance.setSignalingDataEmittedCallback(self._on_signaling_data)
            
            # Build server list (matching bridge format)
            servers = []
            for c in connections:
                try:
                    # Use positional args like the bridge: ip, ipv6, port, username, password, turn, stun
                    srv = tgcalls.RtcServer(
                        getattr(c, 'ip', ''),
                        getattr(c, 'ipv6', ''),
                        getattr(c, 'port', 0),
                        getattr(c, 'username', ''),
                        getattr(c, 'password', ''),
                        getattr(c, 'turn', False),
                        getattr(c, 'stun', False)
                    )
                    servers.append(srv)
                    print(f"   Server: {c.ip}:{c.port}", flush=True)
                except Exception as e:
                    print(f"   ⚠️ Skip server: {e}", flush=True)
            
            # Start call with proper auth key
            auth_key_list = list(self.auth_key) if self.auth_key else []
            print(f"🔑 Auth key: {len(auth_key_list)} bytes", flush=True)
            
            # startCall(servers, authKey, isOutgoing, logPath)
            self.native_instance.startCall(
                servers,
                auth_key_list,
                True,  # isOutgoing
                ""     # logPath
            )
            
            self.state = "ACTIVE"
            print("🔊 Audio started!", flush=True)
            
        except Exception as e:
            print(f"⚠️ Failed to setup native audio: {e}")
    
    def _on_signaling_data(self, data):
        """Handle signaling data from tgcalls"""
        asyncio.create_task(self._send_signaling_data(bytes(data)))
    
    async def _send_signaling_data(self, data: bytes):
        """Send signaling data to Telegram"""
        try:
            await self.client.invoke(
                functions.phone.SendSignalingData(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    data=data
                )
            )
        except Exception as e:
            print(f"⚠️ Failed to send signaling: {e}")
    
    async def hangup(self):
        """Hang up the call"""
        if not self.call:
            print("No active call")
            return
        
        print("📴 Hanging up...")
        try:
            await self.client.invoke(
                functions.phone.DiscardCall(
                    peer=types.InputPhoneCall(id=self.call_id, access_hash=self.call_access_hash),
                    duration=0,
                    reason=types.PhoneCallDiscardReasonHangup(),
                    connection_id=0
                )
            )
            print("👋 Call ended")
        except Exception as e:
            print(f"❌ Failed to hang up: {e}")
        
        if self.native_instance:
            self.native_instance.stop()
        
        self.state = "ENDED"


# =====================================================
# Main CLI
# =====================================================

async def main():
    parser = argparse.ArgumentParser(description="Telegram Call CLI")
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # Call command
    call_parser = subparsers.add_parser("call", help="Initiate a call")
    call_parser.add_argument("user_id", type=int, help="Telegram user ID to call")
    call_parser.add_argument("--duration", type=int, default=30, help="Max call duration in seconds")
    
    # Hangup command
    subparsers.add_parser("hangup", help="Hang up (not implemented for standalone)")
    
    # Status command
    subparsers.add_parser("status", help="Show status")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    # Load config
    config = load_config()
    api_id = config.get('apiId')
    api_hash = config.get('apiHash')
    
    if not api_id or not api_hash:
        print("ERROR: apiId and apiHash required in config", file=sys.stderr)
        sys.exit(1)
    
    if args.command == "status":
        print("🎤 Telegram Call CLI")
        print(f"   Pyrogram: {'✅' if PYROGRAM_AVAILABLE else '❌'}")
        print(f"   tgcalls: {'✅' if TGCALLS_AVAILABLE else '❌'}")
        print(f"   Session: {SESSION_PATH}")
        return
    
    if args.command == "call":
        # Create client
        client = Client(
            name=str(SESSION_PATH),
            api_id=api_id,
            api_hash=api_hash,
            no_updates=False
        )
        
        async with client:
            # Create outgoing call
            call = OutgoingCall(client, args.user_id)
            
            # Add handler for updates
            client.add_handler(RawUpdateHandler(call.process_update), -1)
            
            # Request the call
            if not await call.request():
                return
            
            # Wait for call to complete or timeout
            print(f"⏱️ Waiting up to {args.duration}s for call...")
            for _ in range(args.duration):
                if call.state in ("ENDED", "FAILED"):
                    break
                await asyncio.sleep(1)
            
            # Hang up if still active
            if call.state not in ("ENDED", "FAILED"):
                await call.hangup()
            
            print("✅ Done!")


if __name__ == "__main__":
    asyncio.run(main())
