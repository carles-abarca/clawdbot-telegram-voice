/**
 * Telegram Userbot Channel Plugin
 * 
 * Channel plugin definition following Clawdbot patterns
 * Voice processing delegated to telegram-voice service
 */

import type { ChannelPlugin } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import { TelegramBridge } from "./telegram-bridge.js";
import { monitorTelegramUserbot } from "./monitor.js";
import { getTelegramUserbotRuntime } from "./runtime.js";
import { expandPath, type TelegramUserbotConfig } from "./config.js";
import { consumeVoiceContext } from "./voice-context.js";
import { getVoiceClient } from "./voice-client.js";

// Plugin state
let activeBridge: TelegramBridge | null = null;

export interface ResolvedTelegramUserbotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: TelegramUserbotConfig;
  configured: boolean;
}

const meta = {
  id: "telegram-userbot",
  label: "Telegram Userbot",
  selectionLabel: "Telegram Userbot (Text + Voice)",
  docsPath: "/channels/telegram-userbot",
  docsLabel: "telegram-userbot",
  blurb: "Telegram userbot with text, voice notes, and voice calls",
  order: 85,
  aliases: ["tg-userbot"] as string[],
};

function getChannelConfig(cfg: any): any {
  return cfg.channels?.["telegram-userbot"];
}

function listAccountIds(cfg: any): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];
  if (channelCfg.accounts) {
    return Object.keys(channelCfg.accounts).filter(
      (id) => channelCfg.accounts[id]?.enabled !== false
    );
  }
  // Legacy single-account format
  if (channelCfg.apiId && channelCfg.enabled !== false) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

function resolveAccount(cfg: any, accountId?: string): ResolvedTelegramUserbotAccount {
  const resolvedId = normalizeAccountId(accountId);
  const channelCfg = getChannelConfig(cfg);
  
  if (!channelCfg) {
    return {
      accountId: resolvedId,
      enabled: false,
      config: {} as TelegramUserbotConfig,
      configured: false,
    };
  }

  // Check accounts map first
  const accountCfg = channelCfg.accounts?.[resolvedId];
  if (accountCfg) {
    return {
      accountId: resolvedId,
      name: accountCfg.name,
      enabled: accountCfg.enabled !== false,
      config: buildConfig(accountCfg),
      configured: Boolean(accountCfg.apiId),
    };
  }

  // Legacy single-account format
  if (resolvedId === DEFAULT_ACCOUNT_ID && channelCfg.apiId) {
    return {
      accountId: resolvedId,
      name: channelCfg.name,
      enabled: channelCfg.enabled !== false,
      config: buildConfig(channelCfg),
      configured: true,
    };
  }

  return {
    accountId: resolvedId,
    enabled: false,
    config: {} as TelegramUserbotConfig,
    configured: false,
  };
}

function buildConfig(cfg: any): TelegramUserbotConfig {
  // Expand ~ and $HOME in paths (kept for backward compatibility)
  const sttConfig = cfg.stt ? {
    ...cfg.stt,
    whisperPath: expandPath(cfg.stt.whisperPath),
    modelPath: expandPath(cfg.stt.modelPath),
    detectModelPath: expandPath(cfg.stt.detectModelPath),
  } : undefined;
  
  const ttsConfig = cfg.tts ? {
    ...cfg.tts,
    piperPath: expandPath(cfg.tts.piperPath),
    voicePath: expandPath(cfg.tts.voicePath),
  } : undefined;

  return {
    enabled: cfg.enabled !== false,
    telegram: {
      apiId: cfg.apiId,
      apiHash: cfg.apiHash,
      phone: cfg.phone,
      sessionPath: expandPath(cfg.sessionPath) || `${process.env.HOME}/.clawdbot/telegram-userbot/session`,
      pythonEnvPath: expandPath(cfg.pythonEnvPath) || `${process.env.HOME}/.clawdbot/telegram-userbot/venv`,
      allowedUsers: cfg.allowedUsers || [],
    },
    stt: sttConfig,
    tts: ttsConfig,
  };
}

export const telegramUserbotPlugin: ChannelPlugin<ResolvedTelegramUserbotAccount> = {
  id: "telegram-userbot",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    voice: true,
    voiceNotes: true,
  },
  reload: { configPrefixes: ["channels.telegram-userbot"] },
  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ account }) => 
      (account?.config?.telegram?.allowedUsers ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) => 
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: "allowlist",
      allowFrom: (account?.config?.telegram?.allowedUsers ?? []).map(String),
      policyPath: "channels.telegram-userbot.allowedUsers",
      allowFromPath: "channels.telegram-userbot.allowedUsers",
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const cleaned = trimmed.replace(/^telegram-userbot:/i, "").trim();
      return cleaned || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => /^\d+$/.test(raw.trim()),
      hint: "<userId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      if (!activeBridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
      }
      
      const userId = parseInt(to, 10);
      
      // Check if user has pending voice context (wants TTS response)
      const voiceContext = consumeVoiceContext(to);
      
      if (voiceContext) {
        // User sent a voice message → respond with voice
        console.log(`[telegram-userbot] Voice context found for ${to}, converting to TTS (lang=${voiceContext.language})`);
        
        try {
          const voiceClient = getVoiceClient();
          const isAvailable = await voiceClient.isAvailable();
          
          if (isAvailable) {
            // Synthesize text to speech
            const result = await voiceClient.synthesize(text, to);
            
            if (result.audio_path && !result.error) {
              // Send as voice note
              await activeBridge.request("send_voice", {
                user_id: userId,
                audio_path: result.audio_path,
              });
              console.log(`[telegram-userbot] Voice response sent to ${to}`);
              return { ok: true, channel: "telegram-userbot" };
            } else {
              console.warn(`[telegram-userbot] TTS failed: ${result.error}, falling back to text`);
            }
          } else {
            console.warn(`[telegram-userbot] Voice service not available, falling back to text`);
          }
        } catch (error) {
          console.error(`[telegram-userbot] TTS error: ${error}, falling back to text`);
        }
      }
      
      // Default: send as text
      try {
        await activeBridge.request("send_text", {
          user_id: userId,
          text,
        });
        return { ok: true, channel: "telegram-userbot" };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      if (!activeBridge?.isConnected) {
        return { ok: false, error: "Bridge not connected" };
      }
      try {
        if (mediaUrl && (mediaUrl.endsWith('.ogg') || mediaUrl.endsWith('.wav') || mediaUrl.endsWith('.mp3'))) {
          await activeBridge.request("send_voice", {
            user_id: parseInt(to, 10),
            audio_path: mediaUrl,
          });
        } else {
          await activeBridge.request("send_text", {
            user_id: parseInt(to, 10),
            text: text || `[Media: ${mediaUrl}]`,
          });
        }
        return { ok: true, channel: "telegram-userbot" };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const config = account.config;
      
      const log = ctx.log ?? {
        info: (msg: string) => console.log(`[telegram-userbot] ${msg}`),
        warn: (msg: string) => console.warn(`[telegram-userbot] ${msg}`),
        error: (msg: string) => console.error(`[telegram-userbot] ${msg}`),
        debug: (msg: string) => console.debug(`[telegram-userbot] ${msg}`),
      };
      
      if (!config.telegram?.apiId) {
        log.error(`[${account.accountId}] Missing apiId in config`);
        return;
      }

      log.info(`[${account.accountId}] Starting Telegram userbot bridge...`);
      log.info("[telegram-userbot] Voice processing delegated to telegram-voice service");

      // Start bridge (only Telegram messaging, voice via service)
      activeBridge = new TelegramBridge(config.telegram, log);
      
      activeBridge.on("telegram:ready", (data: { name: string; username: string }) => {
        log.info(`[telegram-userbot] Connected as ${data.name} (@${data.username})`);
      });

      activeBridge.on("error", (error: Error) => {
        log.error(`[telegram-userbot] Bridge error: ${error.message}`);
      });

      await activeBridge.start();
      log.info("[telegram-userbot] Bridge started successfully!");

      // Start monitor (voice processing via telegram-voice service)
      await monitorTelegramUserbot({
        bridge: activeBridge,
        config,
        accountId: account.accountId,
        abortSignal: ctx.abortSignal,
        log,
      });
    },
    stop: async () => {
      if (activeBridge) {
        await activeBridge.stop();
        activeBridge = null;
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
