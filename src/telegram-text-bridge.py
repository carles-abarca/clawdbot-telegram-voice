#!/usr/bin/env python3
"""
Telegram Text Bridge - Lightweight version (NO pytgcalls)
Only handles text messages via Pyrogram

Much lighter than the full voice bridge (~50MB vs ~500MB+)
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
        
        self.app = Client(
            self.session_name,
            api_id=api_id,
            api_hash=api_hash,
            workdir=self.workdir,
        )
        
        # Register message handler
        @self.app.on_message(filters.private & ~filters.me)
        async def message_handler(client: Client, message: Message):
            await self._handle_message(message)
        
    def emit_event(self, event: str, data: dict):
        """Send event to Node.js"""
        msg = json.dumps({"event": event, "data": data})
        print(f"EVENT:{msg}", flush=True)
        
    def send_response(self, request_id: str, success: bool, data: dict = None, error: str = None):
        """Send response to Node.js"""
        response = {
            "id": request_id,
            "success": success,
            "data": data,
            "error": error
        }
        print(f"RESPONSE:{json.dumps(response)}", flush=True)

    def is_user_allowed(self, user_id: int) -> bool:
        """Check if user is in allowlist"""
        if not self.allowed_users:
            return True
        return user_id in self.allowed_users
        
    async def handle_request(self, request: dict):
        """Handle incoming request from Node.js"""
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
                    
            elif action == "shutdown":
                self.running = False
                self._shutdown_event.set()
                self.send_response(req_id, True)
                
            else:
                self.send_response(req_id, False, error=f"unknown action: {action}")
                
        except Exception as e:
            self.send_response(req_id, False, error=str(e))
            
    async def stdin_reader(self):
        """Read requests from Node.js via stdin"""
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
                
    async def _handle_message(self, message: Message):
        """Handle incoming private messages"""
        user_id = message.from_user.id if message.from_user else None
        
        if not user_id or not self.is_user_allowed(user_id):
            return
        
        # Mark message as read
        try:
            await self.app.read_chat_history(message.chat.id)
        except:
            pass
        
        event_data = {
            "user_id": user_id,
            "username": message.from_user.username,
            "first_name": message.from_user.first_name,
            "text": message.text or message.caption or "",
            "message_id": message.id,
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
        else:
            self.emit_event("message.private", event_data)
                
    async def run(self):
        """Main run loop"""
        def signal_handler(sig, frame):
            self.running = False
            self._shutdown_event.set()
            
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        try:
            await self.app.start()
            me = await self.app.get_me()
            self.emit_event("ready", {
                "user_id": me.id,
                "username": me.username,
                "name": me.first_name
            })
            
            # Start stdin reader
            reader_task = asyncio.create_task(self.stdin_reader())
            
            # Keep running until shutdown
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
