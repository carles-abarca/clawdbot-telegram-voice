/**
 * Telegram Voice Plugin - Python Bridge
 * 
 * Communicates with Python process running pytgcalls for Telegram voice calls.
 * Uses JSON-RPC over stdin/stdout for IPC.
 * 
 * Updated 2026-01-29: Compatible with pyrofork + pytgcalls 2.2.x
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

// Python bridge script - Updated for pyrofork + pytgcalls 2.2.x
const BRIDGE_SCRIPT = `
#!/usr/bin/env python3
"""
Telegram Voice Bridge - Python side
Handles pytgcalls for Telegram voice calls

Compatible with:
- pyrofork >= 2.3.x (installs as pyrogram)
- py-tgcalls >= 2.2.x
- ntgcalls >= 2.0.x
"""

import asyncio
import json
import sys
import os
import signal
import tempfile
from typing import Optional
from pathlib import Path

# Add paths for local installations
sys.path.insert(0, os.path.expanduser("~/jarvis-voice-env/lib/python3.12/site-packages"))

from pyrogram import Client, filters
from pyrogram.types import Message
from pyrogram.handlers import MessageHandler
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream, AudioQuality, StreamEnded


class TelegramVoiceBridge:
    def __init__(self, api_id: int, api_hash: str, session_path: str, allowed_users: list[int] = None):
        self.session_name = Path(session_path).stem
        self.workdir = str(Path(session_path).parent)
        
        self.app = Client(
            self.session_name,
            api_id=api_id,
            api_hash=api_hash,
            workdir=self.workdir,
        )
        self.pytgcalls = PyTgCalls(self.app)
        self.current_call: Optional[int] = None
        self.allowed_users = allowed_users or []
        self.running = True
        self._shutdown_event = asyncio.Event()
        
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
            return True  # No allowlist = allow all
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
                    
                self.send_response(req_id, True, {
                    "connected": is_connected,
                    "current_call": self.current_call,
                    "pytgcalls_version": "2.2.x"
                })
                
            elif action == "join":
                chat_id = payload.get("chat_id")
                if not chat_id:
                    self.send_response(req_id, False, error="chat_id required")
                    return
                
                # Check allowlist
                if not self.is_user_allowed(chat_id):
                    self.send_response(req_id, False, error="User not in allowlist")
                    return
                    
                try:
                    # Join with a silent stream initially
                    # For private calls, we use play() to start streaming
                    self.current_call = chat_id
                    self.emit_event("call.joined", {"chat_id": chat_id})
                    self.send_response(req_id, True, {"chat_id": chat_id})
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
                
            elif action == "leave":
                if self.current_call:
                    try:
                        await self.pytgcalls.leave_call(self.current_call)
                    except Exception as e:
                        self.emit_event("warning", {"message": f"Error leaving call: {e}"})
                    
                    old_call = self.current_call
                    self.current_call = None
                    self.emit_event("call.left", {"chat_id": old_call})
                self.send_response(req_id, True)
                
            elif action == "send_audio":
                audio_path = payload.get("audio_path")
                if not audio_path or not os.path.exists(audio_path):
                    self.send_response(req_id, False, error="audio_path required and must exist")
                    return
                    
                if not self.current_call:
                    self.send_response(req_id, False, error="not in a call")
                    return
                    
                try:
                    # Stream audio file using pytgcalls 2.x API
                    await self.pytgcalls.play(
                        self.current_call,
                        MediaStream(
                            audio_path,
                            audio_parameters=AudioQuality.HIGH,
                        )
                    )
                    self.send_response(req_id, True)
                except Exception as e:
                    self.send_response(req_id, False, error=str(e))
            
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
                
    def setup_message_handlers(self):
        """Setup Pyrogram message handlers - MUST be called BEFORE app.start()"""
        bridge = self  # Capture self for closure
        
        async def on_private_message(client: Client, message: Message):
            # Debug log
            bridge.emit_event("debug", {"msg": f"Received message from {message.from_user.id if message.from_user else 'unknown'}"})
            
            user_id = message.from_user.id if message.from_user else None
            if not user_id or not bridge.is_user_allowed(user_id):
                bridge.emit_event("debug", {"msg": f"User {user_id} not allowed or invalid"})
                return
            
            # Mark message as read (blue double tick)
            try:
                await client.read_chat_history(message.chat.id)
            except:
                pass
            
            event_data = {
                "user_id": user_id,
                "username": message.from_user.username,
                "text": message.text or "",
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
                bridge.emit_event("message.voice", event_data)
            else:
                bridge.emit_event("message.private", event_data)
        
        # Register handler using add_handler (works before start)
        self.app.add_handler(MessageHandler(on_private_message, filters.private & filters.incoming))
                
    def setup_pytgcalls_handlers(self):
        """Setup pytgcalls event handlers - called after pyrogram starts"""
        
        @self.pytgcalls.on_update(StreamEnded)
        async def on_stream_end(client, update: StreamEnded):
            chat_id = getattr(update, 'chat_id', None)
            self.emit_event("stream.ended", {"chat_id": chat_id})
                
    async def run(self):
        """Main run loop"""
        # Setup signal handlers
        def signal_handler(sig, frame):
            self.running = False
            self._shutdown_event.set()
            
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        try:
            # Setup message handlers BEFORE starting pyrogram
            self.setup_message_handlers()
            
            # Start pyrogram (pyrofork)
            await self.app.start()
            me = await self.app.get_me()
            self.emit_event("pyrogram.ready", {
                "user_id": me.id,
                "username": me.username,
                "name": me.first_name
            })
            
            # Setup pytgcalls handlers (after pyrogram starts)
            self.setup_pytgcalls_handlers()
            
            # Start pytgcalls
            await self.pytgcalls.start()
            self.emit_event("ready", {"status": "connected", "pytgcalls": "2.2.x"})
            
            # Start stdin reader as a task
            reader_task = asyncio.create_task(self.stdin_reader())
            
            # Wait for shutdown signal
            await self._shutdown_event.wait()
            
            # Cancel stdin reader
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass
                
        except Exception as e:
            self.emit_event("error", {"message": str(e), "fatal": True})
            raise
        finally:
            # Cleanup
            try:
                if self.current_call:
                    await self.pytgcalls.leave_call(self.current_call)
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
    
    # Parse allowed users if provided
    allowed_users = []
    if len(sys.argv) > 4:
        try:
            allowed_users = [int(u) for u in sys.argv[4].split(",") if u.strip()]
        except:
            pass
    
    bridge = TelegramVoiceBridge(api_id, api_hash, session_path, allowed_users)
    asyncio.run(bridge.run())


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
    this.bridgeScriptPath = path.join(os.tmpdir(), "telegram-voice-bridge.py");
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Start the Python bridge process
   */
  async start(): Promise<void> {
    if (this.process) {
      this.logger.warn("Bridge already running");
      return;
    }

    // Write bridge script
    fs.writeFileSync(this.bridgeScriptPath, BRIDGE_SCRIPT, { mode: 0o755 });

    // Get Python path from venv
    const pythonPath = path.join(this.config.pythonEnvPath, "bin", "python3");

    if (!fs.existsSync(pythonPath)) {
      throw new Error(`Python not found at: ${pythonPath}`);
    }

    // Build allowed users arg
    const allowedUsersArg = this.config.allowedUsers?.join(",") || "";

    this.logger.info(`Starting Telegram bridge with Python: ${pythonPath}`);

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

    // Setup readline for stdout
    const rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => this.handleOutput(line));

    // Log stderr
    this.process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      // Filter out pytgcalls banner
      if (!msg.includes("PyTgCalls v") && !msg.includes("Licensed under")) {
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

    this.logger.info("Telegram bridge connected successfully");
  }

  /**
   * Stop the bridge process
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    this.logger.info("Stopping Telegram bridge...");

    // Clear pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge stopping"));
    }
    this.pendingRequests.clear();

    // Send shutdown request
    try {
      await this.request("shutdown", {});
    } catch {
      // Ignore errors during shutdown
    }

    // Wait a bit for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Kill process if still running
    if (this.process) {
      this.process.kill("SIGTERM");

      // Wait for exit with timeout
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

    // Cleanup script
    if (fs.existsSync(this.bridgeScriptPath)) {
      try {
        fs.unlinkSync(this.bridgeScriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.logger.info("Telegram bridge stopped");
  }

  /**
   * Send request to Python bridge
   */
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

  /**
   * Handle output from Python bridge
   */
  private handleOutput(line: string): void {
    // Filter pytgcalls banner from stdout too
    if (line.includes("PyTgCalls v") || line.includes("Licensed under") || line.includes("Copyright")) {
      this.logger.debug(`Bridge: ${line}`);
      return;
    }

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

  /**
   * Handle event from Python bridge
   */
  private handleEvent(event: BridgeEvent): void {
    this.logger.debug(`Bridge event: ${event.event} ${JSON.stringify(event.data)}`);

    switch (event.event) {
      case "ready":
        this.emit("ready");
        break;
      case "pyrogram.ready":
        this.logger.info(`Telegram connected as: ${event.data.name} (@${event.data.username})`);
        this.emit("telegram:ready", event.data);
        break;
      case "call.joined":
        this.emit("call:joined", event.data);
        break;
      case "call.left":
        this.emit("call:left", event.data);
        break;
      case "call.kicked":
        this.emit("call:kicked", event.data);
        break;
      case "stream.ended":
        this.emit("stream:ended", event.data);
        break;
      case "audio.received":
        this.emit("audio:received", event.data);
        break;
      case "message.private":
        this.emit("message:private", event.data);
        break;
      case "message.voice":
        this.emit("message:voice", event.data);
        break;
      case "warning":
        this.logger.warn(`Bridge warning: ${event.data.message}`);
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

  // Convenience methods

  async getStatus(): Promise<{ connected: boolean; currentCall: number | null }> {
    const response = await this.request("status");
    return {
      connected: response.data?.connected as boolean || false,
      currentCall: response.data?.current_call as number | null || null,
    };
  }

  async joinCall(chatId: number): Promise<void> {
    const response = await this.request("join", { chat_id: chatId });
    if (!response.success) {
      throw new Error(response.error || "Failed to join call");
    }
  }

  async leaveCall(): Promise<void> {
    const response = await this.request("leave");
    if (!response.success) {
      throw new Error(response.error || "Failed to leave call");
    }
  }

  async sendAudio(audioPath: string): Promise<void> {
    const response = await this.request("send_audio", { audio_path: audioPath });
    if (!response.success) {
      throw new Error(response.error || "Failed to send audio");
    }
  }
}
