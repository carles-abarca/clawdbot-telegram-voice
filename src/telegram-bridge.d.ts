/**
 * Telegram Text Bridge - Lightweight Python Bridge
 *
 * Communicates with Python process running Pyrogram for text messages.
 * NO pytgcalls - much lighter (~50MB vs ~500MB+)
 *
 * Uses JSON-RPC over stdin/stdout for IPC.
 */
import { EventEmitter } from "node:events";
import type { TelegramConfig } from "./config.js";
import type { BridgeResponse, Logger } from "./types.js";
export declare class TelegramBridge extends EventEmitter {
    private config;
    private logger;
    private process;
    private pendingRequests;
    private requestId;
    private bridgeScriptPath;
    private _isConnected;
    constructor(config: TelegramConfig, logger: Logger);
    get isConnected(): boolean;
    /**
     * Kill any orphaned bridge processes from previous runs.
     * This prevents duplicate processes after gateway restarts.
     */
    private killOrphanedProcesses;
    start(): Promise<void>;
    stop(): Promise<void>;
    request(action: string, payload?: Record<string, unknown>): Promise<BridgeResponse>;
    private handleOutput;
    private handleEvent;
    getStatus(): Promise<{
        connected: boolean;
    }>;
}
//# sourceMappingURL=telegram-bridge.d.ts.map