#!/usr/bin/env python3
"""
Telegram Text Bridge - Lightweight version (NO pytgcalls)
Handles text, media, and location messages via Pyrogram
"""

import asyncio
import json
import sys
import os
import signal
from pathlib import Path

from pyrogram import Client, filters
from pyrogram.types import Message


class TelegramTextBridge:
    def __init__(self, api_id: int, api_hash: str, session_path: str, allowed_users: list[int] = None):
        self.session_name = Path(session_path).stem
        self.workdir = str(Path(session_path).parent)
        self.allowed_users = allowed_users or []
        self.running = True
        self._shutdown_event = asyncio.Event()
        # Track active live locations by (user_id, message_id) to detect stops
        self._active_live_locations: dict[tuple[int, int], dict] = {}
        
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
                self.send_response(req_id, True, {"connected": is_connected})
                
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
                    
            elif action == "shutdown":
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
            self.emit_event("ready", {"user_id": me.id, "username": me.username, "name": me.first_name})
            
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
