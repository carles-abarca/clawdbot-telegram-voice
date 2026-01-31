/**
 * Telegram Userbot Channel Plugin
 *
 * Channel plugin definition following Clawdbot patterns
 * Voice processing delegated to telegram-voice service
 */
import type { ChannelPlugin } from "clawdbot/plugin-sdk";
import { type TelegramUserbotConfig } from "./config.js";
export interface ResolvedTelegramUserbotAccount {
    accountId: string;
    name?: string;
    enabled: boolean;
    config: TelegramUserbotConfig;
    configured: boolean;
}
export declare const telegramUserbotPlugin: ChannelPlugin<ResolvedTelegramUserbotAccount>;
//# sourceMappingURL=channel.d.ts.map