/**
 * Telegram Voice Plugin - Python Bridge
 * 
 * Communicates with Python process running pytgcalls for Telegram voice calls.
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

// Python bridge script
const BRIDGE_SCRIPT = `
#!/usr/bin/env python3
"""
Telegram Voice Bridge - Python side
Handles pytgcalls for Telegram voice calls
"""

import asyncio
import json
import sys
import os
import signal
from typing import Optional

# Add paths for local installations
sys.path.insert(0, os.path.expanduser("~/jarvis-voice-env/lib/python3.12/site-packages"))

from pyrogram import Client, filters
from pyrogram.types import Message
from pytgcalls import PyTgCalls, StreamType
from pytgcalls.types import Update
from pytgcalls.types.input_stream import AudioPiped, AudioImagePiped
from pytgcalls.types.stream import StreamAudioEnded

class TelegramVoiceBridge:
    def __init__(self, api_id: int, api_hash: str, session_path: str):
        self.app = Client(
            "voice_bridge",
            api_id=api_id,
            api_hash=api_hash,
            workdir=os.path.dirname(session_path),
            session_string=None,
        )
        self.pytgcalls = PyTgCalls(self.app)
        self.current_call: Optional[int] = None
        self.running = True
        
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
        
    async def handle_request(self, request: dict):
        """Handle incoming request from Node.js"""
        req_id = request.get("id", "unknown")
        action = request.get("action")
        payload = request.get("payload", {})
        
        try:
            if action == "status":
                self.send_response(req_id, True, {
                    "connected": self.app.is_connected if hasattr(self.app, 'is_connected') else False,
                    "current_call": self.current_call
                })
                
            elif action == "join":
                chat_id = payload.get("chat_id")
                if not chat_id:
                    self.send_response(req_id, False, error="chat_id required")
                    return
                    
                # For now, join with silence (we'll stream audio later)
                # await self.pytgcalls.join_group_call(chat_id, AudioPiped("silence.raw"))
                self.current_call = chat_id
                self.emit_event("call.joined", {"chat_id": chat_id})
                self.send_response(req_id, True, {"chat_id": chat_id})
                
            elif action == "leave":
                if self.current_call:
                    await self.pytgcalls.leave_group_call(self.current_call)
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
                    
                # Stream audio file
                await self.pytgcalls.change_stream(
                    self.current_call,
                    AudioPiped(audio_path)
                )
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
                line = await reader.readline()
                if not line:
                    break
                    
                line = line.decode().strip()
                if line.startswith("REQUEST:"):
                    request = json.loads(line[8:])
                    await self.handle_request(request)
            except Exception as e:
                self.emit_event("error", {"message": str(e)})
                
    async def run(self):
        """Main run loop"""
        # Setup signal handlers
        def signal_handler(sig, frame):
            self.running = False
            
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        # Start pyrogram and pytgcalls
        await self.app.start()
        await self.pytgcalls.start()
        
        self.emit_event("ready", {"status": "connected"})
        
        # Setup pytgcalls event handlers
        @self.pytgcalls.on_stream_end()
        async def on_stream_end(client: PyTgCalls, update: Update):
            self.emit_event("stream.ended", {"chat_id": update.chat_id})
            
        @self.pytgcalls.on_kicked()
        async def on_kicked(client: PyTgCalls, chat_id: int):
            self.emit_event("call.kicked", {"chat_id": chat_id})
            if self.current_call == chat_id:
                self.current_call = None
                
        # Setup pyrogram handlers for incoming calls
        @self.app.on_message(filters.incoming)
        async def on_message(client: Client, message: Message):
            # Handle voice chat invitations, etc.
            pass
            
        # Read stdin for requests
        await self.stdin_reader()
        
        # Cleanup
        if self.current_call:
            await self.pytgcalls.leave_group_call(self.current_call)
        await self.pytgcalls.stop()
        await self.app.stop()

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: bridge.py <api_id> <api_hash> <session_path>", file=sys.stderr)
        sys.exit(1)
        
    api_id = int(sys.argv[1])
    api_hash = sys.argv[2]
    session_path = sys.argv[3]
    
    bridge = TelegramVoiceBridge(api_id, api_hash, session_path)
    asyncio.run(bridge.run())
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

    this.logger.info(`Starting Telegram bridge with Python: ${pythonPath}`);

    this.process = spawn(pythonPath, [
      this.bridgeScriptPath,
      String(this.config.apiId),
      this.config.apiHash,
      this.config.sessionPath,
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
      this.logger.error(`Bridge stderr: ${data.toString().trim()}`);
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
        reject(new Error("Bridge startup timeout"));
      }, 30000);

      this.once("ready", () => {
        clearTimeout(timeout);
        this._isConnected = true;
        resolve();
      });
    });

    this.logger.info("Telegram bridge connected");
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

    // Kill process
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

    this.process = null;
    this._isConnected = false;

    // Cleanup script
    if (fs.existsSync(this.bridgeScriptPath)) {
      fs.unlinkSync(this.bridgeScriptPath);
    }
  }

  /**
   * Send request to Python bridge
   */
  async request(action: string, payload?: Record<string, unknown>): Promise<BridgeResponse> {
    if (!this.process || !this._isConnected) {
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
    } else {
      this.logger.debug(`Bridge: ${line}`);
    }
  }

  /**
   * Handle event from Python bridge
   */
  private handleEvent(event: BridgeEvent): void {
    this.logger.debug(`Bridge event: ${event.event}`);

    switch (event.event) {
      case "ready":
        this.emit("ready");
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
      case "error":
        this.logger.error(`Bridge error: ${event.data.message}`);
        this.emit("error", new Error(String(event.data.message)));
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
