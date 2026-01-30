/**
 * Telegram Text Bridge - Lightweight Python Bridge
 * 
 * Communicates with Python process running Pyrogram for text messages.
 * NO pytgcalls - much lighter (~50MB vs ~500MB+)
 * 
 * Uses JSON-RPC over stdin/stdout for IPC.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import type { TelegramConfig } from "./config.js";
import type { 
  BridgeRequest, 
  BridgeResponse, 
  BridgeEvent, 
  Logger,
} from "./types.js";

// Lightweight Python bridge script - NO pytgcalls
const BRIDGE_SCRIPT = `#!/usr/bin/env python3
"""
Telegram Text Bridge - Lightweight version (NO pytgcalls)
Only handles text messages via Pyrogram
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
        
        @self.app.on_message(filters.private & ~filters.me)
        async def message_handler(client: Client, message: Message):
            await self._handle_message(message)
        
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
                # Show any chat action status
                user_id = payload.get("user_id")
                action_type = payload.get("action_type", "typing")  # typing, upload_audio, record_audio, cancel
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
                # Legacy: Show "recording voice" status
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
                
    async def _handle_message(self, message: Message):
        user_id = message.from_user.id if message.from_user else None
        
        if not user_id or not self.is_user_allowed(user_id):
            return
        
        # Don't mark as read here - let the caller decide when to mark as read
        # (e.g., after transcription is complete for voice messages)
        
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
`;

export class TelegramBridge extends EventEmitter {
  private config: TelegramConfig;
  private logger: Logger;
  private process: ChildProcess | null = null;
  private pendingRequests: Map<string, {
    resolve: (response: BridgeResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private requestId = 0;
  private bridgeScriptPath: string;
  private _isConnected = false;

  constructor(config: TelegramConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.bridgeScriptPath = path.join(os.tmpdir(), "telegram-text-bridge.py");
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Kill any orphaned bridge processes from previous runs.
   * This prevents duplicate processes after gateway restarts.
   */
  private async killOrphanedProcesses(): Promise<void> {
    const { execSync } = await import("node:child_process");
    
    try {
      // Find and kill any existing telegram-text-bridge.py processes
      const result = execSync(
        `pgrep -f "telegram-text-bridge.py.*${this.config.sessionPath}" 2>/dev/null || true`,
        { encoding: "utf-8" }
      ).trim();
      
      if (result) {
        const pids = result.split("\n").filter(Boolean);
        this.logger.warn(`Found ${pids.length} orphaned bridge process(es), killing: ${pids.join(", ")}`);
        
        for (const pid of pids) {
          try {
            execSync(`kill -TERM ${pid} 2>/dev/null || true`);
          } catch {
            // Process may have already exited
          }
        }
        
        // Wait a moment for processes to terminate
        await new Promise((resolve) => setTimeout(resolve, 1000));
        
        // Force kill any remaining
        for (const pid of pids) {
          try {
            execSync(`kill -KILL ${pid} 2>/dev/null || true`);
          } catch {
            // Process may have already exited
          }
        }
      }
    } catch (error) {
      this.logger.debug(`Orphan cleanup check: ${error}`);
    }
  }

  async start(): Promise<void> {
    if (this.process) {
      this.logger.warn("Bridge already running");
      return;
    }

    // Kill any orphaned bridge processes from previous runs
    await this.killOrphanedProcesses();

    // Write bridge script
    fs.writeFileSync(this.bridgeScriptPath, BRIDGE_SCRIPT, { mode: 0o755 });

    // Get Python path from venv
    const pythonPath = path.join(this.config.pythonEnvPath, "bin", "python3");

    if (!fs.existsSync(pythonPath)) {
      throw new Error(`Python not found at: ${pythonPath}`);
    }

    const allowedUsersArg = this.config.allowedUsers?.join(",") || "";

    this.logger.info(`Starting Telegram text bridge with Python: ${pythonPath}`);

    this.process = spawn(pythonPath, [
      this.bridgeScriptPath,
      String(this.config.apiId),
      this.config.apiHash,
      this.config.sessionPath,
      allowedUsersArg,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });

    const rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => this.handleOutput(line));

    this.process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        this.logger.error(`Bridge stderr: ${msg}`);
      }
    });

    this.process.on("close", (code) => {
      this.logger.info(`Bridge process exited with code ${code}`);
      this._isConnected = false;
      this.process = null;
      this.emit("disconnected");
    });

    this.process.on("error", (error) => {
      this.logger.error(`Bridge process error: ${error.message}`);
      this._isConnected = false;
      this.emit("error", error);
    });

    // Wait for ready event
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Bridge startup timeout (30s)"));
      }, 30000);

      this.once("ready", () => {
        clearTimeout(timeout);
        this._isConnected = true;
        resolve();
      });

      this.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.logger.info("Telegram text bridge connected successfully");
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.logger.info("Stopping Telegram bridge...");

    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge stopping"));
    }
    this.pendingRequests.clear();

    try {
      await this.request("shutdown", {});
    } catch {
      // Ignore errors during shutdown
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (this.process) {
      this.process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process?.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.process = null;
    this._isConnected = false;

    if (fs.existsSync(this.bridgeScriptPath)) {
      try {
        fs.unlinkSync(this.bridgeScriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.logger.info("Telegram bridge stopped");
  }

  async request(action: string, payload?: Record<string, unknown>): Promise<BridgeResponse> {
    if (!this.process) {
      throw new Error("Bridge not running");
    }

    if (!this._isConnected && action !== "shutdown") {
      throw new Error("Bridge not connected");
    }

    const id = `req_${++this.requestId}`;
    const request: BridgeRequest = { id, action: action as BridgeRequest["action"], payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${action}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const message = `REQUEST:${JSON.stringify(request)}\n`;
      this.process!.stdin!.write(message);
    });
  }

  private handleOutput(line: string): void {
    if (line.startsWith("RESPONSE:")) {
      try {
        const response: BridgeResponse = JSON.parse(line.substring(9));
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
        }
      } catch (_error) {
        this.logger.error(`Failed to parse response: ${line}`);
      }
    } else if (line.startsWith("EVENT:")) {
      try {
        const event: BridgeEvent = JSON.parse(line.substring(6));
        this.handleEvent(event);
      } catch (_error) {
        this.logger.error(`Failed to parse event: ${line}`);
      }
    } else if (line.trim()) {
      this.logger.debug(`Bridge: ${line}`);
    }
  }

  private handleEvent(event: BridgeEvent): void {
    this.logger.debug(`Bridge event: ${event.event} ${JSON.stringify(event.data)}`);

    switch (event.event) {
      case "ready":
        this.logger.info(`Telegram connected as: ${event.data.name} (@${event.data.username})`);
        this.emit("ready");
        this.emit("telegram:ready", event.data);
        break;
      case "message.private":
        this.emit("message:private", event.data);
        break;
      case "message.voice":
        this.emit("message:voice", event.data);
        break;
      case "message.media":
        this.emit("message:media", event.data);
        break;
      case "shutdown":
        this.logger.info("Bridge shutdown complete");
        break;
      case "error":
        this.logger.error(`Bridge error: ${event.data.message}`);
        if (event.data.fatal) {
          this.emit("error", new Error(String(event.data.message)));
        }
        break;
      default:
        this.emit(event.event, event.data);
    }
  }

  async getStatus(): Promise<{ connected: boolean }> {
    const response = await this.request("status");
    return {
      connected: response.data?.connected as boolean || false,
    };
  }
}
