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

export class VoiceClient {
  private socketPath: string;
  private tcpHost: string;
  private tcpPort: number;
  private transport: "unix" | "tcp";
  private requestId: number = 0;
  private timeout: number;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 120000; // 120s default (medium model + transcription can be slow)

    // Detectar plataforma
    if (process.platform === "linux") {
      this.transport = "unix";
      this.socketPath = `/run/user/${process.getuid?.() ?? 1000}/telegram-voice.sock`;
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
