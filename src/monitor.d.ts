/**
 * Telegram Userbot Monitor - Handles inbound messages
 *
 * Uses telegram-voice service for STT/TTS via JSON-RPC
 */
import type { TelegramUserbotConfig } from "./config.js";
import type { TelegramBridge } from "./telegram-bridge.js";
export type MonitorOptions = {
    bridge: TelegramBridge;
    config: TelegramUserbotConfig;
    accountId: string;
    abortSignal?: AbortSignal;
    statusSink?: (patch: {
        lastInboundAt?: number;
        lastOutboundAt?: number;
    }) => void;
    log?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
        debug: (msg: string) => void;
    };
};
export declare function monitorTelegramUserbot(opts: MonitorOptions): Promise<void>;
//# sourceMappingURL=monitor.d.ts.map