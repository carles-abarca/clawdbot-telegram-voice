/**
 * Voice Service Client - JSON-RPC client for telegram-voice-service
 */
import * as net from "net";
export class VoiceClient {
    socketPath;
    tcpHost;
    tcpPort;
    transport;
    requestId = 0;
    timeout;
    constructor(options) {
        this.timeout = options?.timeout ?? 120000; // 120s default (medium model + transcription can be slow)
        // Detectar plataforma
        if (process.platform === "linux") {
            this.transport = "unix";
            this.socketPath = `/run/user/${process.getuid?.() ?? 1000}/telegram-voice.sock`;
            this.tcpHost = "";
            this.tcpPort = 0;
        }
        else {
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
    async transcribe(audioPath, userId) {
        return this.call("transcribe", {
            audio_path: audioPath,
            user_id: userId,
        });
    }
    /**
     * Sintetitza text a àudio
     */
    async synthesize(text, userId) {
        return this.call("synthesize", {
            text,
            user_id: userId,
        });
    }
    /**
     * Estableix l'idioma per un usuari
     */
    async setLanguage(userId, language) {
        return this.call("language.set", {
            user_id: userId,
            language,
        });
    }
    /**
     * Obté l'idioma actual d'un usuari
     */
    async getLanguage(userId) {
        return this.call("language.get", {
            user_id: userId,
        });
    }
    /**
     * Obté l'estat del servei
     */
    async getStatus() {
        return this.call("status", {});
    }
    /**
     * Health check
     */
    async health() {
        return this.call("health", {});
    }
    /**
     * Comprova si el servei està disponible
     */
    async isAvailable(timeoutMs = 5000) {
        try {
            // Use shorter timeout for availability check
            const originalTimeout = this.timeout;
            this.timeout = timeoutMs;
            const result = await this.health();
            this.timeout = originalTimeout;
            return result.status === "ok";
        }
        catch {
            return false;
        }
    }
    /**
     * Fa una crida JSON-RPC al servei
     */
    async call(method, params) {
        const request = {
            jsonrpc: "2.0",
            method,
            params,
            id: ++this.requestId,
        };
        const requestData = JSON.stringify(request);
        const responseData = await this.sendRequest(Buffer.from(requestData));
        const response = JSON.parse(responseData.toString());
        if (response.error) {
            throw new Error(`RPC Error ${response.error.code}: ${response.error.message}`);
        }
        return response.result;
    }
    /**
     * Envia una request al servei via socket
     */
    sendRequest(data) {
        return new Promise((resolve, reject) => {
            const socket = this.transport === "unix"
                ? net.createConnection(this.socketPath)
                : net.createConnection(this.tcpPort, this.tcpHost);
            const chunks = [];
            let expectedLength = null;
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
let _client = null;
export function getVoiceClient() {
    if (!_client) {
        _client = new VoiceClient();
    }
    return _client;
}
//# sourceMappingURL=voice-client.js.map