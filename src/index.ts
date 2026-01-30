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

interface PluginApi {
  config: any;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerChannel: (opts: { plugin: ChannelPlugin }) => void;
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
    sendText: (opts: SendTextOpts) => Promise<{ ok: boolean; error?: string }>;
    sendVoice?: (opts: SendVoiceOpts) => Promise<{ ok: boolean; error?: string }>;
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

// Global state
let bridge: TelegramBridge | null = null;
let pluginApi: PluginApi | null = null;
let pluginConfig: any = null;
let whisperSTT: WhisperSTT | null = null;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let piperTTS: PiperTTS | null = null;

/**
 * Get plugin config from Clawdbot config
 */
function getPluginConfig(cfg: any): any | null {
  const channelCfg = cfg.channels?.["telegram-voice"];
  if (!channelCfg?.enabled) return null;
  
  return {
    enabled: true,
    telegram: {
      apiId: channelCfg.apiId || channelCfg.telegram?.apiId,
      apiHash: channelCfg.apiHash || channelCfg.telegram?.apiHash,
      phone: channelCfg.phone || channelCfg.telegram?.phone,
      sessionPath: channelCfg.sessionPath || process.env.HOME + "/jarvis-voice",
      pythonEnvPath: channelCfg.pythonEnvPath || process.env.HOME + "/jarvis-voice-env",
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
async function handleIncomingMessage(data: {
  user_id: number;
  username?: string;
  text: string;
  message_id: number;
  voice_path?: string;
  duration?: number;
}) {
  if (!pluginApi || !pluginConfig) {
    console.error("[telegram-voice] Plugin not initialized");
    return;
  }

  const logger = pluginApi.logger;
  let messageText = data.text;

  // If it's a voice message, transcribe it
  if (data.voice_path && whisperSTT) {
    logger.info(`[telegram-voice] Transcribing voice message from ${data.user_id}`);
    try {
      const result = await whisperSTT.transcribe(data.voice_path);
      messageText = result.text;
      logger.info(`[telegram-voice] Transcribed: "${result.text.substring(0, 50)}..."`);
    } catch (error) {
      logger.error(`[telegram-voice] Transcription failed: ${error}`);
      messageText = "[Voice message - transcription failed]";
    }
  }

  logger.info(`[telegram-voice] Message from ${data.username || data.user_id}: ${messageText.substring(0, 50)}...`);

  // Inject message into Clawdbot session
  if (pluginApi.runtime?.injectMessage) {
    try {
      await pluginApi.runtime.injectMessage({
        channel: "telegram-voice",
        senderId: String(data.user_id),
        senderName: data.username || `User ${data.user_id}`,
        text: messageText,
        sessionKey: `agent:main:telegram-voice:dm:${data.user_id}`,
      });
    } catch (error) {
      logger.error(`[telegram-voice] Failed to inject message: ${error}`);
    }
  } else {
    logger.warn("[telegram-voice] runtime.injectMessage not available - message not processed");
  }
}

/**
 * Send text message via userbot
 */
async function sendText(opts: SendTextOpts): Promise<{ ok: boolean; error?: string }> {
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
}

/**
 * Send voice message via userbot
 */
async function sendVoice(opts: SendVoiceOpts): Promise<{ ok: boolean; error?: string }> {
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
}

/**
 * Channel plugin definition
 */
const channelPlugin: ChannelPlugin = {
  id: "telegram-voice",
  meta: {
    id: "telegram-voice",
    label: "Telegram Voice",
    selectionLabel: "Telegram Userbot (Voice + Text)",
    docsPath: "/channels/telegram-voice",
    blurb: "Telegram userbot with voice calls, voice notes, and text messaging",
    aliases: ["tg-voice", "tg-userbot"],
  },
  capabilities: {
    chatTypes: ["direct"],
    voice: true,
    voiceNotes: true,
  },
  config: {
    listAccountIds: (cfg) => {
      const accounts = cfg.channels?.["telegram-voice"]?.accounts;
      return accounts ? Object.keys(accounts) : ["default"];
    },
    resolveAccount: (cfg, accountId) => {
      const channelCfg = cfg.channels?.["telegram-voice"];
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
        ctx.api.logger.info("[telegram-voice] Plugin disabled");
        return;
      }

      pluginApi = ctx.api;
      pluginConfig = config;

      ctx.api.logger.info("[telegram-voice] Starting Telegram userbot bridge...");

      // Initialize STT
      if (config.stt) {
        whisperSTT = new WhisperSTT(config.stt, ctx.api.logger);
        ctx.api.logger.info("[telegram-voice] Whisper STT initialized");
      }

      // Initialize TTS
      if (config.tts) {
        piperTTS = new PiperTTS(config.tts, ctx.api.logger);
        ctx.api.logger.info("[telegram-voice] Piper TTS initialized");
      }

      bridge = new TelegramBridge(config.telegram, ctx.api.logger);

      // Listen for incoming messages
      bridge.on("message:private", handleIncomingMessage);
      bridge.on("message:voice", handleIncomingMessage);

      // Listen for connection events
      bridge.on("telegram:ready", (data) => {
        ctx.api.logger.info(`[telegram-voice] Connected as ${data.name} (@${data.username})`);
      });

      bridge.on("error", (error) => {
        ctx.api.logger.error(`[telegram-voice] Bridge error: ${error.message}`);
      });

      bridge.on("disconnected", () => {
        ctx.api.logger.warn("[telegram-voice] Bridge disconnected");
      });

      try {
        await bridge.start();
        ctx.api.logger.info("[telegram-voice] Bridge started successfully!");
      } catch (error) {
        ctx.api.logger.error(`[telegram-voice] Failed to start bridge: ${error}`);
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
export default function register(api: PluginApi) {
  api.logger.info("[telegram-voice] Registering channel plugin...");
  api.registerChannel({ plugin: channelPlugin });
  api.logger.info("[telegram-voice] Channel plugin registered!");
}

export { TelegramBridge } from "./telegram-bridge.js";
export type { TelegramVoiceConfig } from "./config.js";
