/**
 * Clawdbot Telegram Userbot Channel Plugin
 *
 * A channel plugin that uses a Telegram userbot (Pyrogram) for:
 * - Text messaging
 * - Voice notes (with Whisper STT / Piper TTS)
 * - Voice calls (future)
 */
import { TelegramBridge } from "./telegram-bridge.js";
import { WhisperSTT } from "./stt.js";
import { PiperTTS } from "./tts.js";
// Global state
let bridge = null;
let pluginApi = null;
let pluginConfig = null;
let whisperSTT = null;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let piperTTS = null;
/**
 * Get plugin config from Clawdbot config
 * Looks in both plugins.entries["telegram-userbot"].config AND channels["telegram-userbot"]
 */
function getPluginConfig(cfg) {
    // Try plugin config first (from plugins.entries)
    let channelCfg = cfg.plugins?.entries?.["telegram-userbot"]?.config;
    // Fallback to channels config
    if (!channelCfg) {
        channelCfg = cfg.channels?.["telegram-userbot"];
    }
    if (!channelCfg)
        return null;
    // Check enabled status (plugin enabled in entries OR channel enabled)
    const pluginEnabled = cfg.plugins?.entries?.["telegram-userbot"]?.enabled;
    if (!pluginEnabled && !channelCfg?.enabled)
        return null;
    return {
        enabled: true,
        telegram: {
            apiId: channelCfg.telegram?.apiId || channelCfg.apiId,
            apiHash: channelCfg.telegram?.apiHash || channelCfg.apiHash,
            phone: channelCfg.telegram?.phone || channelCfg.phone,
            sessionPath: channelCfg.telegram?.sessionPath || channelCfg.sessionPath || process.env.HOME + "/jarvis-voice",
            pythonEnvPath: channelCfg.telegram?.pythonEnvPath || channelCfg.pythonEnvPath || process.env.HOME + "/jarvis-voice-env",
            allowedUsers: channelCfg.allowedUsers || [],
        },
        stt: channelCfg.stt || {
            provider: "whisper-cpp",
            whisperPath: process.env.HOME + "/whisper.cpp/build/bin/whisper-cli",
            modelPath: process.env.HOME + "/whisper.cpp/models/ggml-small.bin",
            language: "ca",
        },
        tts: channelCfg.tts || {
            provider: "piper",
            piperPath: process.env.HOME + "/piper/piper/piper",
            voicePath: process.env.HOME + "/piper/voices/ca_ES-upc_pau-x_low.onnx",
            lengthScale: 0.85,
        },
    };
}
/**
 * Handle incoming message from userbot
 */
async function handleIncomingMessage(data) {
    if (!pluginApi || !pluginConfig) {
        console.error("[telegram-userbot] Plugin not initialized");
        return;
    }
    const logger = pluginApi.logger;
    let messageText = data.text;
    // If it's a voice message, transcribe it
    if (data.voice_path && whisperSTT) {
        logger.info(`[telegram-userbot] Transcribing voice message from ${data.user_id}`);
        try {
            const result = await whisperSTT.transcribe(data.voice_path);
            messageText = result.text;
            logger.info(`[telegram-userbot] Transcribed: "${result.text.substring(0, 50)}..."`);
        }
        catch (error) {
            logger.error(`[telegram-userbot] Transcription failed: ${error}`);
            messageText = "[Voice message - transcription failed]";
        }
    }
    logger.info(`[telegram-userbot] Message from ${data.username || data.user_id}: ${messageText.substring(0, 50)}...`);
    // Inject message into Clawdbot session
    if (pluginApi.runtime?.injectMessage) {
        try {
            await pluginApi.runtime.injectMessage({
                channel: "telegram-userbot",
                senderId: String(data.user_id),
                senderName: data.username || `User ${data.user_id}`,
                text: messageText,
                sessionKey: `agent:main:telegram-userbot:dm:${data.user_id}`,
            });
        }
        catch (error) {
            logger.error(`[telegram-userbot] Failed to inject message: ${error}`);
        }
    }
    else {
        logger.warn("[telegram-userbot] runtime.injectMessage not available - message not processed");
    }
}
/**
 * Send text message via userbot
 */
async function sendText(opts) {
    if (!bridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
    }
    try {
        await bridge.request("send_text", {
            user_id: parseInt(opts.to, 10),
            text: opts.text,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: String(error) };
    }
}
/**
 * Send voice message via userbot
 */
async function sendVoice(opts) {
    if (!bridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
    }
    try {
        await bridge.request("send_voice", {
            user_id: parseInt(opts.to, 10),
            audio_path: opts.audioPath,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: String(error) };
    }
}
/**
 * Channel plugin definition
 */
const channelPlugin = {
    id: "telegram-userbot",
    meta: {
        id: "telegram-userbot",
        label: "Telegram Userbot",
        selectionLabel: "Telegram Userbot (Voice + Text)",
        docsPath: "/channels/telegram-userbot",
        blurb: "Telegram userbot with voice calls, voice notes, and text messaging",
        aliases: ["tg-userbot", "tg-userbot"],
    },
    capabilities: {
        chatTypes: ["direct"],
        voice: true,
        voiceNotes: true,
    },
    config: {
        listAccountIds: (cfg) => {
            const accounts = cfg.channels?.["telegram-userbot"]?.accounts;
            return accounts ? Object.keys(accounts) : ["default"];
        },
        resolveAccount: (cfg, accountId) => {
            const channelCfg = cfg.channels?.["telegram-userbot"];
            if (channelCfg?.accounts) {
                return channelCfg.accounts[accountId ?? "default"] ?? { accountId };
            }
            return { accountId: "default", ...channelCfg };
        },
    },
    gateway: {
        start: async (ctx) => {
            const config = getPluginConfig(ctx.config);
            if (!config?.enabled) {
                ctx.api.logger.info("[telegram-userbot] Plugin disabled");
                return;
            }
            pluginApi = ctx.api;
            pluginConfig = config;
            ctx.api.logger.info("[telegram-userbot] Starting Telegram userbot bridge...");
            // Initialize STT
            if (config.stt) {
                whisperSTT = new WhisperSTT(config.stt, ctx.api.logger);
                ctx.api.logger.info("[telegram-userbot] Whisper STT initialized");
            }
            // Initialize TTS
            if (config.tts) {
                piperTTS = new PiperTTS(config.tts, ctx.api.logger);
                ctx.api.logger.info("[telegram-userbot] Piper TTS initialized");
            }
            bridge = new TelegramBridge(config.telegram, ctx.api.logger);
            // Listen for incoming messages
            bridge.on("message:private", handleIncomingMessage);
            bridge.on("message:voice", handleIncomingMessage);
            // Listen for connection events
            bridge.on("telegram:ready", (data) => {
                ctx.api.logger.info(`[telegram-userbot] Connected as ${data.name} (@${data.username})`);
            });
            bridge.on("error", (error) => {
                ctx.api.logger.error(`[telegram-userbot] Bridge error: ${error.message}`);
            });
            bridge.on("disconnected", () => {
                ctx.api.logger.warn("[telegram-userbot] Bridge disconnected");
            });
            try {
                await bridge.start();
                ctx.api.logger.info("[telegram-userbot] Bridge started successfully!");
            }
            catch (error) {
                ctx.api.logger.error(`[telegram-userbot] Failed to start bridge: ${error}`);
                throw error;
            }
        },
        stop: async () => {
            if (bridge) {
                await bridge.stop();
                bridge = null;
            }
            pluginApi = null;
            pluginConfig = null;
            whisperSTT = null;
            piperTTS = null;
        },
    },
    outbound: {
        deliveryMode: "direct",
        sendText,
        sendVoice,
    },
};
/**
 * Plugin registration
 */
export default function register(api) {
    api.logger.info("[telegram-userbot] Registering channel plugin...");
    api.registerChannel({ plugin: channelPlugin });
    api.logger.info("[telegram-userbot] Channel plugin registered!");
}
export { TelegramBridge } from "./telegram-bridge.js";
//# sourceMappingURL=index.js.map