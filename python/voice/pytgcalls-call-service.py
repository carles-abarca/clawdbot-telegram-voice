#!/usr/bin/env python3
"""
PyTgCalls-based Call Service - Modern implementation using py-tgcalls

This replaces the manual tgcalls.NativeInstance implementation with
the stable, high-level py-tgcalls API.
"""

import asyncio
import logging
from typing import Optional, Dict, Callable, List
from datetime import datetime
from pathlib import Path

try:
    from pyrogram import Client
    PYROGRAM_AVAILABLE = True
except ImportError:
    PYROGRAM_AVAILABLE = False
    logging.error("Pyrogram not available")

try:
    from pytgcalls import PyTgCalls
    from pytgcalls.types import Update
    from pytgcalls.types.input_stream import AudioPiped
    from pytgcalls.types.input_stream.quality import HighQualityAudio
    PYTGCALLS_AVAILABLE = True
except ImportError:
    PYTGCALLS_AVAILABLE = False
    logging.error("py-tgcalls not available - install with: pip install py-tgcalls")


log = logging.getLogger(__name__)


class PyTgCallsService:
    """
    Modern call service using py-tgcalls high-level API

    Replaces the old tgcalls.NativeInstance manual implementation
    with stable py-tgcalls that handles all the complexity.
    """

    def __init__(
        self,
        client: Client,
        voice_service = None,
        auto_answer: bool = True,
        auto_answer_delay: float = 1.0,
        max_duration: int = 300,
        greeting: Optional[str] = None,
        goodbye: Optional[str] = None
    ):
        if not PYTGCALLS_AVAILABLE:
            raise RuntimeError("py-tgcalls not installed")

        self.client = client
        self.voice_service = voice_service
        self.auto_answer = auto_answer
        self.auto_answer_delay = auto_answer_delay
        self.max_duration = max_duration
        self.greeting = greeting
        self.goodbye = goodbye

        # PyTgCalls instance
        self.pytgcalls = PyTgCalls(client)

        # Active call tracking
        self.active_call_id: Optional[int] = None
        self.active_user_id: Optional[int] = None
        self.call_start_time: Optional[datetime] = None

        # Event handlers for JSON-RPC events
        self.event_handlers: List[Callable] = []

        # Call timeout task
        self._timeout_task: Optional[asyncio.Task] = None

    async def start(self):
        """Start the PyTgCalls client"""
        log.info("Starting PyTgCalls service...")

        # Register event handlers
        @self.pytgcalls.on_stream_end()
        async def on_stream_end(client, update: Update):
            await self._handle_stream_end(update)

        @self.pytgcalls.on_kicked()
        async def on_kicked(client, update: Update):
            await self._handle_kicked(update)

        # Note: py-tgcalls v2 doesn't have direct P2P call handlers yet
        # We need to handle incoming calls via Pyrogram's RawUpdateHandler
        # and use pytgcalls for group calls / audio streaming
        # For P2P calls, we'll need to wait for py-tgcalls to add support
        # or use a hybrid approach

        await self.pytgcalls.start()
        log.info("✅ PyTgCalls service started")

    async def stop(self):
        """Stop the PyTgCalls client"""
        if self.active_call_id:
            await self.hangup()

        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()

        log.info("Stopping PyTgCalls service...")
        # Note: py-tgcalls doesn't have explicit stop in v2
        # It stops when the client stops

    # ========================================================================
    # P2P Call Methods (Future - awaiting py-tgcalls P2P support)
    # ========================================================================

    async def request_call(self, user_id: int) -> Dict:
        """
        Request outgoing P2P call

        Note: py-tgcalls v2.2.10 focuses on group calls.
        P2P calls need to be handled via Pyrogram directly.
        We'll need a hybrid approach or wait for py-tgcalls update.
        """
        log.warning("P2P calls not yet supported in py-tgcalls v2")
        log.info("P2P call support requires:")
        log.info("  1. Wait for py-tgcalls to add P2P call support")
        log.info("  2. OR use hybrid: Pyrogram for signaling + pytgcalls for audio")
        log.info("  3. OR use group call workaround (create 1-person group)")

        return {
            "error": "P2P calls not yet implemented in py-tgcalls v2",
            "workaround": "Use group call or wait for library update"
        }

    async def accept_call(self, call_id: int) -> Dict:
        """Accept incoming P2P call"""
        log.warning("P2P calls not yet supported in py-tgcalls v2")
        return {"error": "P2P calls not yet implemented"}

    async def reject_call(self, call_id: int) -> Dict:
        """Reject incoming P2P call"""
        log.warning("P2P calls not yet supported in py-tgcalls v2")
        return {"error": "P2P calls not yet implemented"}

    async def hangup(self) -> Dict:
        """Hang up active call"""
        if not self.active_call_id:
            return {"error": "No active call"}

        try:
            # For group calls:
            # await self.pytgcalls.leave_group_call(self.active_call_id)

            # For P2P calls (when supported):
            # Will be similar to leave_group_call

            call_id = self.active_call_id
            duration = self._get_call_duration()

            self.active_call_id = None
            self.active_user_id = None
            self.call_start_time = None

            if self._timeout_task:
                self._timeout_task.cancel()
                self._timeout_task = None

            await self.emit_event('call.ended', {
                'call_id': str(call_id),
                'duration': duration,
                'reason': 'hangup'
            })

            return {"status": "ended", "duration": duration}

        except Exception as e:
            log.error(f"Error hanging up: {e}")
            return {"error": str(e)}

    async def get_status(self) -> Dict:
        """Get current call status"""
        if self.active_call_id:
            return {
                "active": True,
                "call_id": str(self.active_call_id),
                "user_id": self.active_user_id,
                "duration": self._get_call_duration(),
                "pytgcalls_version": self._get_pytgcalls_version()
            }
        else:
            return {
                "active": False,
                "pytgcalls_available": PYTGCALLS_AVAILABLE,
                "pytgcalls_version": self._get_pytgcalls_version()
            }

    # ========================================================================
    # Group Call Methods (Currently Supported in py-tgcalls v2)
    # ========================================================================

    async def join_group_call(self, chat_id: int, audio_path: Optional[str] = None) -> Dict:
        """
        Join a group voice chat

        This works in current py-tgcalls v2.2.10
        Can be used as workaround for P2P calls by creating a group
        """
        try:
            if audio_path:
                # Join with audio file
                await self.pytgcalls.play(
                    chat_id,
                    AudioPiped(audio_path, HighQualityAudio())
                )
            else:
                # Join without playing (just listen)
                await self.pytgcalls.join_group_call(
                    chat_id,
                    AudioPiped('blank.raw', HighQualityAudio())  # Blank audio
                )

            self.active_call_id = chat_id
            self.call_start_time = datetime.now()

            await self.emit_event('call.connected', {
                'chat_id': chat_id,
                'type': 'group_call'
            })

            return {"status": "connected", "chat_id": chat_id}

        except Exception as e:
            log.error(f"Error joining group call: {e}")
            return {"error": str(e)}

    async def leave_group_call(self, chat_id: int) -> Dict:
        """Leave group voice chat"""
        try:
            await self.pytgcalls.leave_group_call(chat_id)

            duration = self._get_call_duration()
            self.active_call_id = None
            self.call_start_time = None

            await self.emit_event('call.ended', {
                'chat_id': chat_id,
                'duration': duration,
                'type': 'group_call'
            })

            return {"status": "left", "duration": duration}

        except Exception as e:
            log.error(f"Error leaving group call: {e}")
            return {"error": str(e)}

    async def play_audio(self, chat_id: int, audio_path: str) -> Dict:
        """Play audio file in active call"""
        try:
            await self.pytgcalls.play(
                chat_id,
                AudioPiped(audio_path, HighQualityAudio())
            )
            return {"status": "playing", "audio_path": audio_path}
        except Exception as e:
            log.error(f"Error playing audio: {e}")
            return {"error": str(e)}

    # ========================================================================
    # Event Handlers
    # ========================================================================

    async def _handle_stream_end(self, update: Update):
        """Handle stream end event"""
        log.info(f"Stream ended: {update}")
        # Could auto-leave or play next audio

    async def _handle_kicked(self, update: Update):
        """Handle being kicked from call"""
        log.warning(f"Kicked from call: {update}")
        self.active_call_id = None
        self.call_start_time = None

        await self.emit_event('call.ended', {
            'reason': 'kicked'
        })

    # ========================================================================
    # Event System
    # ========================================================================

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

    # ========================================================================
    # Utilities
    # ========================================================================

    def _get_call_duration(self) -> float:
        """Get current call duration in seconds"""
        if self.call_start_time:
            return (datetime.now() - self.call_start_time).total_seconds()
        return 0.0

    def _get_pytgcalls_version(self) -> str:
        """Get py-tgcalls version"""
        try:
            from pytgcalls import __version__
            return __version__
        except:
            return "unknown"


# ============================================================================
# Migration Notes
# ============================================================================
"""
MIGRATION FROM tgcalls TO py-tgcalls:

1. OLD APPROACH (tgcalls 3.0.0.dev6):
   - Manual NativeInstance creation
   - Manual Diffie-Hellman key exchange
   - Manual signaling callbacks
   - Manual WebRTC server setup
   - Crashes with segfault

2. NEW APPROACH (py-tgcalls 2.2.10):
   - High-level PyTgCalls client
   - Automatic key exchange
   - Automatic signaling
   - Automatic WebRTC setup
   - Stable, no crashes

3. CURRENT LIMITATION:
   py-tgcalls v2.2.10 focuses on GROUP CALLS, not P2P calls yet.

   OPTIONS:
   a) Wait for py-tgcalls to add P2P call support (recommended)
   b) Use hybrid: Pyrogram for P2P signaling + pytgcalls for audio
   c) Workaround: Create 2-person group call instead of P2P
   d) Use signaling-only approach (calls without audio streaming)

4. WHAT WORKS NOW:
   - Group voice chats (fully functional)
   - Audio streaming to group chats
   - Audio playback in calls
   - Event handling

5. WHAT'S PENDING:
   - P2P call support in py-tgcalls
   - OR hybrid implementation combining Pyrogram + pytgcalls

6. RECOMMENDATION:
   For now, implement signaling-only P2P calls (phone call UI without audio)
   Or use group call workaround (create private group for 1-on-1)
   Full P2P audio awaits py-tgcalls library update or hybrid implementation.
"""
