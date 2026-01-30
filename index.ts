/**
 * Clawdbot Telegram Userbot Plugin
 * 
 * Text and voice conversations via Telegram userbot
 * 100% local STT/TTS stack (Whisper + Piper)
 */

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { TelegramBridge } from "./src/telegram-bridge.js";
import { WhisperSTT } from "./src/stt.js";
import { PiperTTS } from "./src/tts.js";
import type { TelegramUserbotConfig } from "./src/config.js";

// Global state
let bridge: TelegramBridge | null = null;
let pluginApi: ClawdbotPluginApi | null = null;
let pluginConfig: TelegramUserbotConfig | null = null;
let whisperSTT: WhisperSTT | null = null;
let piperTTS: PiperTTS | null = null;

/**
 * Get plugin config from Clawdbot config
 */
function getPluginConfig(cfg: any): TelegramUserbotConfig | null {
  // Try plugin config first (from plugins.entries)
  let channelCfg = cfg.plugins?.entries?.["telegram-userbot"]?.config;
  
  if (!channelCfg) return null;
  
  const pluginEnabled = cfg.plugins?.entries?.["telegram-userbot"]?.enabled;
  if (!pluginEnabled) return null;
  
  return {
    enabled: true,
    telegram: {
      apiId: channelCfg.telegram?.apiId,
      apiHash: channelCfg.telegram?.apiHash,
      phone: channelCfg.telegram?.phone,
      sessionPath: channelCfg.telegram?.sessionPath || process.env.HOME + "/jarvis-voice",
      pythonEnvPath: channelCfg.telegram?.pythonEnvPath || process.env.HOME + "/jarvis-voice-env",
      allowedUsers: channelCfg.allowedUsers || [],
    },
    stt: channelCfg.stt || {
      provider: "whisper-cpp",
      whisperPath: process.env.HOME + "/whisper.cpp/build/bin/whisper-cli",
      modelPath: process.env.HOME + "/whisper.cpp/models/ggml-small.bin",
      language: "auto",
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
async function handleIncomingMessage(data: {
  user_id: number;
  username?: string;
  text: string;
  message_id: number;
  voice_path?: string;
  duration?: number;
}) {
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
    } catch (error) {
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
    } catch (error) {
      logger.error(`[telegram-userbot] Failed to inject message: ${error}`);
    }
  } else {
    logger.warn("[telegram-userbot] runtime.injectMessage not available");
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
    selectionLabel: "Telegram Userbot (Text + Voice)",
    docsPath: "/channels/telegram-userbot",
    blurb: "Telegram userbot with text, voice notes, and voice calls",
    aliases: ["tg-userbot"],
  },
  capabilities: {
    chatTypes: ["direct"] as const,
    voice: true,
    voiceNotes: true,
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (_cfg: any, accountId?: string) => ({ accountId: accountId ?? "default" }),
  },
  gateway: {
    start: async (ctx: { config: any; api: ClawdbotPluginApi }) => {
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
      bridge.on("telegram:ready", (eventData: { name: string; username: string }) => {
        ctx.api.logger.info(`[telegram-userbot] Connected as ${eventData.name} (@${eventData.username})`);
      });

      bridge.on("error", (error: Error) => {
        ctx.api.logger.error(`[telegram-userbot] Bridge error: ${error.message}`);
      });

      bridge.on("disconnected", () => {
        ctx.api.logger.warn("[telegram-userbot] Bridge disconnected");
      });

      try {
        await bridge.start();
        ctx.api.logger.info("[telegram-userbot] Bridge started successfully!");
      } catch (error) {
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
    deliveryMode: "direct" as const,
    sendText: async (opts: { to: string; text: string }) => {
      if (!bridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
      }
      try {
        await bridge.request("send_text", {
          user_id: parseInt(opts.to, 10),
          text: opts.text,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    sendVoice: async (opts: { to: string; audioPath: string }) => {
      if (!bridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
      }
      try {
        await bridge.request("send_voice", {
          user_id: parseInt(opts.to, 10),
          audio_path: opts.audioPath,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  },
};

/**
 * Plugin definition (official format)
 */
const plugin = {
  id: "telegram-userbot",
  name: "Telegram Userbot",
  description: "Text and voice conversations via Telegram userbot - 100% local STT/TTS",
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {},
  },
  register(api: ClawdbotPluginApi) {
    api.logger.info("[telegram-userbot] Registering channel plugin...");
    api.registerChannel({ plugin: channelPlugin });
    api.logger.info("[telegram-userbot] Channel plugin registered!");
  },
};

export default plugin;
