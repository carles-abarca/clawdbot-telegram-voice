/**
 * Clawdbot Telegram Userbot Channel Plugin
 *
 * A channel plugin that uses a Telegram userbot (Pyrogram) for:
 * - Text messaging
 * - Voice notes (with Whisper STT / Piper TTS)
 * - Voice calls (future)
 */
interface PluginApi {
    config: any;
    logger: {
        info: (msg: string) => void;
        error: (msg: string) => void;
        warn: (msg: string) => void;
        debug: (msg: string) => void;
    };
    registerChannel: (opts: {
        plugin: ChannelPlugin;
    }) => void;
    runtime?: {
        injectMessage?: (opts: InjectMessageOpts) => Promise<void>;
    };
}
interface InjectMessageOpts {
    channel: string;
    accountId?: string;
    senderId: string;
    senderName?: string;
    text: string;
    mediaUrls?: string[];
    replyTo?: string;
    sessionKey?: string;
}
interface ChannelPlugin {
    id: string;
    meta: {
        id: string;
        label: string;
        selectionLabel: string;
        docsPath: string;
        blurb: string;
        aliases: string[];
    };
    capabilities: {
        chatTypes: string[];
        voice?: boolean;
        voiceNotes?: boolean;
    };
    config: {
        listAccountIds: (cfg: any) => string[];
        resolveAccount: (cfg: any, accountId?: string) => any;
    };
    gateway?: {
        start?: (ctx: GatewayContext) => Promise<void>;
        stop?: () => Promise<void>;
    };
    outbound: {
        deliveryMode: string;
        sendText: (opts: SendTextOpts) => Promise<{
            ok: boolean;
            error?: string;
        }>;
        sendVoice?: (opts: SendVoiceOpts) => Promise<{
            ok: boolean;
            error?: string;
        }>;
    };
}
interface GatewayContext {
    config: any;
    api: PluginApi;
}
interface SendTextOpts {
    to: string;
    text: string;
    accountId?: string;
}
interface SendVoiceOpts {
    to: string;
    audioPath: string;
    accountId?: string;
}
/**
 * Plugin registration
 */
export default function register(api: PluginApi): void;
export { TelegramBridge } from "./telegram-bridge.js";
export type { TelegramVoiceConfig } from "./config.js";
//# sourceMappingURL=index.d.ts.map