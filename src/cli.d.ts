/**
 * Telegram Voice Plugin - CLI Commands
 */
import type { Command } from "commander";
import type { TelegramVoiceConfig } from "./config.js";
import type { TelegramVoiceRuntime, Logger } from "./types.js";
export declare function registerTelegramVoiceCli(params: {
    program: Command;
    config: TelegramVoiceConfig;
    ensureRuntime: () => Promise<TelegramVoiceRuntime>;
    logger: Logger;
}): void;
//# sourceMappingURL=cli.d.ts.map