/**
 * Voice Service Client - JSON-RPC client for telegram-voice-service
 */

import * as net from "net";
import * as path from "path";
import * as os from "os";

export interface TranscribeResult {
  text?: string;
  language?: string;
  audio_path?: string;
  error?: string;
  details?: string;
}

export interface SynthesizeResult {
  audio_path?: string;
  language?: string;
  text?: string;
  error?: string;
  details?: string;
}

export interface LanguageResult {
  user_id?: string;
  language?: string;
  language_name?: string;
  error?: string;
}

export interface StatusResult {
  service: string;
  version: string;
  transport: string;
  socket: string;
  whisper_available: boolean;
  piper_available: boolean;
  supported_languages: string[];
  default_language: string;
  active_users: number;
}

export interface HealthResult {
  status: string;
  timestamp: string;
}

export interface CallStartResult {
  status: string;
  call_id?: number;
  error?: string;
}

export interface CallHangupResult {
  status: string;
  duration?: number;
  error?: string;
}

export interface CallStatusResult {
  active: boolean;
  state: string;
  call_id?: number;
  user_id?: number;
  duration?: number;
  error?: string;
}

export interface CallSpeakResult {
  status: string;
  audio_path?: string;
  error?: string;
}

export interface CallPlayResult {
  status: string;
  error?: string;
}

export interface CallEvent {
  type: "call.ringing" | "call.connected" | "call.speech" | "call.ended";
  params: {
    call_id?: string;
    user_id?: number;
    text?: string;
    language?: string;
    audio_path?: string;
    duration?: number;
    reason?: string;
  };
}

interface JSONRPCRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: number;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
  id: number;
}

interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

type CallEventListener = (event: CallEvent) => void | Promise<void>;

export class VoiceClient {
  private socketPath: string;
  private tcpHost: string;
  private tcpPort: number;
  private transport: "unix" | "tcp";
  private requestId: number = 0;
  private timeout: number;
  private eventListeners: CallEventListener[] = [];
  private eventSocket: net.Socket | null = null;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 120000; // 120s default (medium model + transcription can be slow)

    // Detectar plataforma
    if (process.platform === "linux") {
      this.transport = "unix";
      this.socketPath = `/run/user/${process.getuid?.() ?? 1000}/tts-stt.sock`;
      this.tcpHost = "";
      this.tcpPort = 0;
    } else {
      // macOS
      this.transport = "tcp";
      this.socketPath = "";
      this.tcpHost = "127.0.0.1";
      this.tcpPort = 18790;
    }
  }

  /**
   * Transcriu àudio a text
   */
  async transcribe(audioPath: string, userId?: string): Promise<TranscribeResult> {
    return this.call<TranscribeResult>("transcribe", {
      audio_path: audioPath,
      user_id: userId,
    });
  }

  /**
   * Sintetitza text a àudio
   */
  async synthesize(text: string, userId?: string): Promise<SynthesizeResult> {
    return this.call<SynthesizeResult>("synthesize", {
      text,
      user_id: userId,
    });
  }

  /**
   * Estableix l'idioma per un usuari
   */
  async setLanguage(userId: string, language: string): Promise<LanguageResult> {
    return this.call<LanguageResult>("language.set", {
      user_id: userId,
      language,
    });
  }

  /**
   * Obté l'idioma actual d'un usuari
   */
  async getLanguage(userId: string): Promise<LanguageResult> {
    return this.call<LanguageResult>("language.get", {
      user_id: userId,
    });
  }

  /**
   * Obté l'estat del servei
   */
  async getStatus(): Promise<StatusResult> {
    return this.call<StatusResult>("status", {});
  }

  /**
   * Health check
   */
  async health(): Promise<HealthResult> {
    return this.call<HealthResult>("health", {});
  }

  /**
   * Comprova si el servei està disponible
   */
  async isAvailable(timeoutMs: number = 5000): Promise<boolean> {
    try {
      // Use shorter timeout for availability check
      const originalTimeout = this.timeout;
      this.timeout = timeoutMs;
      const result = await this.health();
      this.timeout = originalTimeout;
      return result.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Start a P2P call
   */
  async callStart(userId: number): Promise<CallStartResult> {
    return this.call<CallStartResult>("call.start", {
      user_id: userId,
    });
  }

  /**
   * Hang up the current call
   */
  async callHangup(): Promise<CallHangupResult> {
    return this.call<CallHangupResult>("call.hangup", {});
  }

  /**
   * Get current call status
   */
  async callStatus(): Promise<CallStatusResult> {
    return this.call<CallStatusResult>("call.status", {});
  }

  /**
   * Speak text in the current call (TTS + playback)
   */
  async callSpeak(text: string): Promise<CallSpeakResult> {
    return this.call<CallSpeakResult>("call.speak", {
      text,
    });
  }

  /**
   * Play audio file in the current call
   */
  async callPlay(audioPath: string): Promise<CallPlayResult> {
    return this.call<CallPlayResult>("call.play", {
      audio_path: audioPath,
    });
  }

  /**
   * Add a listener for call events
   */
  onCallEvent(listener: CallEventListener): void {
    this.eventListeners.push(listener);
    // Start event socket if not already running
    if (!this.eventSocket) {
      this.startEventListener();
    }
  }

  /**
   * Remove a call event listener
   */
  offCallEvent(listener: CallEventListener): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
    // Stop event socket if no more listeners
    if (this.eventListeners.length === 0 && this.eventSocket) {
      this.eventSocket.destroy();
      this.eventSocket = null;
    }
  }

  /**
   * Start listening for call events from the service
   */
  private startEventListener(): void {
    if (this.eventSocket) {
      return; // Already listening
    }

    const socket = this.transport === "unix"
      ? net.createConnection(this.socketPath)
      : net.createConnection(this.tcpPort, this.tcpHost);

    this.eventSocket = socket;

    let buffer = "";
    let expectedLength: number | null = null;

    socket.on("connect", () => {
      console.log("[voice-client] Event listener connected");
    });

    socket.on("data", (chunk) => {
      try {
        // Handle length-prefixed JSON-RPC messages
        if (expectedLength === null && chunk.length >= 4) {
          expectedLength = chunk.readUInt32BE(0);
          chunk = chunk.subarray(4);
        }

        buffer += chunk.toString();

        // Try to parse complete messages
        while (buffer.length > 0) {
          try {
            const message = JSON.parse(buffer) as JSONRPCNotification;
            buffer = "";
            expectedLength = null;

            // Handle JSON-RPC notifications (events)
            if (message.method && message.method.startsWith("call.")) {
              const event: CallEvent = {
                type: message.method as CallEvent["type"],
                params: message.params as CallEvent["params"],
              };

              // Emit to all listeners
              for (const listener of this.eventListeners) {
                Promise.resolve(listener(event)).catch(err => {
                  console.error(`[voice-client] Event listener error: ${err}`);
                });
              }
            }
          } catch {
            // Incomplete JSON, wait for more data
            break;
          }
        }
      } catch (err) {
        console.error(`[voice-client] Event parsing error: ${err}`);
      }
    });

    socket.on("error", (err) => {
      console.error(`[voice-client] Event socket error: ${err}`);
    });

    socket.on("close", () => {
      console.log("[voice-client] Event listener disconnected");
      this.eventSocket = null;

      // Reconnect if there are still listeners
      if (this.eventListeners.length > 0) {
        setTimeout(() => this.startEventListener(), 2000);
      }
    });
  }

  /**
   * Comprova la memòria disponible del sistema
   * Returns { lowMemory: boolean, availableMB: number }
   */
  async checkMemory(): Promise<{ lowMemory: boolean; availableMB: number }> {
    try {
      const { execSync } = await import("child_process");
      // Get available memory in KB from /proc/meminfo (Linux)
      const memInfo = execSync("grep MemAvailable /proc/meminfo 2>/dev/null || echo 'MemAvailable: 999999999 kB'")
        .toString();
      const match = memInfo.match(/MemAvailable:\s*(\d+)/);
      const availableKB = match ? parseInt(match[1], 10) : 999999999;
      const availableMB = Math.floor(availableKB / 1024);
      
      // Consider low memory if less than 400MB available
      const lowMemory = availableMB < 400;
      
      return { lowMemory, availableMB };
    } catch {
      // If we can't check, assume we're fine
      return { lowMemory: false, availableMB: 9999 };
    }
  }

  /**
   * Reinicia el servei telegram-voice via systemd
   */
  async restartService(): Promise<boolean> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      
      console.log("[voice-client] Restarting telegram-voice service...");
      await execAsync("systemctl --user restart telegram-voice");
      
      // Wait for service to be available
      let attempts = 0;
      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        if (await this.isAvailable(2000)) {
          console.log("[voice-client] Service restarted successfully");
          return true;
        }
        attempts++;
      }
      
      console.error("[voice-client] Service restart timed out");
      return false;
    } catch (err) {
      console.error(`[voice-client] Failed to restart service: ${err}`);
      return false;
    }
  }

  /**
   * Fa una crida JSON-RPC al servei
   */
  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id: ++this.requestId,
    };

    const requestData = JSON.stringify(request);
    const responseData = await this.sendRequest(Buffer.from(requestData));
    const response: JSONRPCResponse = JSON.parse(responseData.toString());

    if (response.error) {
      throw new Error(`RPC Error ${response.error.code}: ${response.error.message}`);
    }

    return response.result as T;
  }

  /**
   * Envia una request al servei via socket
   */
  private sendRequest(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = this.transport === "unix"
        ? net.createConnection(this.socketPath)
        : net.createConnection(this.tcpPort, this.tcpHost);

      const chunks: Buffer[] = [];
      let expectedLength: number | null = null;
      let receivedLength = 0;

      const timeoutHandle = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      }, this.timeout);

      socket.on("connect", () => {
        // Enviar longitud (4 bytes, big-endian) + data
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32BE(data.length, 0);
        socket.write(lengthBuffer);
        socket.write(data);
      });

      socket.on("data", (chunk) => {
        if (expectedLength === null) {
          // Primer llegir longitud
          expectedLength = chunk.readUInt32BE(0);
          chunk = chunk.subarray(4);
        }

        chunks.push(chunk);
        receivedLength += chunk.length;

        if (receivedLength >= expectedLength) {
          clearTimeout(timeoutHandle);
          socket.end();
          resolve(Buffer.concat(chunks));
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Socket error: ${err.message}`));
      });

      socket.on("close", () => {
        clearTimeout(timeoutHandle);
        if (chunks.length === 0) {
          reject(new Error("Connection closed without response"));
        }
      });
    });
  }
}

// Singleton instance
let _client: VoiceClient | null = null;

export function getVoiceClient(): VoiceClient {
  if (!_client) {
    _client = new VoiceClient();
  }
  return _client;
}
