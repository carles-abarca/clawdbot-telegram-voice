/**
 * Telegram Userbot Monitor - Handles inbound messages
 * 
 * Uses telegram-voice service for STT/TTS via JSON-RPC
 */

import { createTypingCallbacks, logInboundDrop, logTypingFailure } from "clawdbot/plugin-sdk";
import { getTelegramUserbotRuntime } from "./runtime.js";
import type { TelegramUserbotConfig, TelegramConfig } from "./config.js";
import type { TelegramBridge } from "./telegram-bridge.js";
import { getVoiceClient, type VoiceClient } from "./voice-client.js";

export type MonitorOptions = {
  bridge: TelegramBridge;
  config: TelegramUserbotConfig;
  accountId: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

interface IncomingMessage {
  user_id: number;
  username?: string;
  first_name?: string;
  text: string;
  message_id: number;
  voice_path?: string;
  media_path?: string;
  media_type?: string;
  file_name?: string;
  mime_type?: string;
  emoji?: string;
  duration?: number;
}

export async function monitorTelegramUserbot(opts: MonitorOptions): Promise<void> {
  const { bridge, config, accountId, statusSink } = opts;
  const core = getTelegramUserbotRuntime();
  const cfg = core.config.loadConfig();
  
  const logger = core.logging.getChildLogger({ module: "telegram-userbot" });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug(message);
    }
  };

  // Get voice service client
  const voiceClient = getVoiceClient();
  let voiceServiceAvailable = false;
  
  // Check if voice service is available
  try {
    voiceServiceAvailable = await voiceClient.isAvailable();
    if (voiceServiceAvailable) {
      const status = await voiceClient.getStatus();
      logger.info(`Voice service connected: ${status.service} v${status.version}`);
      logger.info(`  Transport: ${status.transport} (${status.socket})`);
      logger.info(`  Languages: ${status.supported_languages.join(", ")}`);
    } else {
      logger.warn("Voice service not available - voice features disabled");
    }
  } catch (err) {
    logger.warn(`Voice service check failed: ${err}`);
  }

  // Handler for incoming messages
  async function handleIncomingMessage(data: IncomingMessage) {
    const startTime = Date.now();
    statusSink?.({ lastInboundAt: startTime });
    
    let messageText = data.text || "";
    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const isVoiceMessage = Boolean(data.voice_path);
    const userId = String(data.user_id);
    
    // Bot name for voice-to-voice trigger (configurable)
    const botName = process.env.BOT_NAME || "Jarvis";
    let wantsVoiceResponse = false;
    
    // Transcribe voice messages via voice service
    if (data.voice_path && voiceServiceAvailable) {
      logger.info(`Transcribing voice message from ${data.user_id} via voice service`);
      
      // Show "upload_document" status while transcribing
      const actionInterval = setInterval(async () => {
        try {
          await bridge.request("chat_action", { user_id: data.user_id, action_type: "upload_document" });
        } catch (err) {
          logVerbose(`telegram-userbot: upload_document refresh failed: ${err}`);
        }
      }, 4000);
      
      try {
        await bridge.request("chat_action", { user_id: data.user_id, action_type: "upload_document" });
      } catch (err) {
        logVerbose(`telegram-userbot: upload_document start failed: ${err}`);
      }
      
      try {
        // Use voice service for transcription (with user's language preference)
        const result = await voiceClient.transcribe(data.voice_path, userId);
        
        if (result.error) {
          throw new Error(result.error);
        }
        
        messageText = result.text || "";
        logger.info(`Transcribed (lang=${result.language}): "${messageText.substring(0, 50)}..."`);
        
        // Set user's language preference based on detected language (for TTS response)
        if (result.language && voiceServiceAvailable) {
          try {
            await voiceClient.setLanguage(userId, result.language);
            logger.info(`Set user language to ${result.language} based on voice input`);
          } catch (err) {
            logger.warn(`Failed to set language: ${err}`);
          }
        }
        
        // Check if transcription starts with bot name
        const trimmedText = messageText.trim().toLowerCase();
        if (trimmedText.startsWith(botName.toLowerCase())) {
          wantsVoiceResponse = true;
          logger.info(`Voice-to-voice mode activated (starts with "${botName}")`);
        }
        
        // Check for language change request in response
        // Format: [LANG:xx] at the start of Claude's response
        // This is handled in the deliver callback
        
      } catch (error) {
        logger.error(`Transcription failed: ${error}`);
        messageText = "[Voice message - transcription failed]";
      }
      
      clearInterval(actionInterval);
      
      // Mark as read after transcription
      try {
        await bridge.request("mark_read", { user_id: data.user_id });
        logVerbose(`telegram-userbot: marked as read after transcription`);
      } catch (err) {
        logVerbose(`telegram-userbot: mark_read failed: ${err}`);
      }
      
      // If NOT voice-to-voice mode, wrap for translation
      if (!wantsVoiceResponse && messageText.trim()) {
        messageText = `[NOTA DE VEU REBUDA - No és una petició directa a mi. Mostra la transcripció original i la traducció a la llengua de la nostra conversa]\n\nTranscripció: "${messageText}"`;
        logger.info(`Wrapped transcription for Claude to translate`);
      }
      
      // Start appropriate action
      const nextAction = wantsVoiceResponse ? "record_audio" : "typing";
      try {
        await bridge.request("chat_action", { user_id: data.user_id, action_type: nextAction });
      } catch (err) {
        logVerbose(`telegram-userbot: ${nextAction} start failed: ${err}`);
      }
    } else if (data.voice_path && !voiceServiceAvailable) {
      logger.warn("Voice message received but voice service not available");
      messageText = "[Voice message - service unavailable]";
      
      try {
        await bridge.request("mark_read", { user_id: data.user_id });
      } catch (err) {
        logVerbose(`telegram-userbot: mark_read failed: ${err}`);
      }
    } else {
      // For non-voice messages, mark as read immediately
      try {
        await bridge.request("mark_read", { user_id: data.user_id });
      } catch (err) {
        logVerbose(`telegram-userbot: mark_read failed: ${err}`);
      }
    }
    
    // Handle media messages
    if (data.media_path) {
      mediaPath = data.media_path;
      mediaType = data.media_type;
      
      if (!messageText) {
        switch (data.media_type) {
          case "photo":
            messageText = "[Photo attached]";
            break;
          case "document":
            messageText = `[Document: ${data.file_name || "file"}]`;
            break;
          case "video":
            messageText = "[Video attached]";
            break;
          case "sticker":
            messageText = `[Sticker: ${data.emoji || "🎭"}]`;
            break;
          case "audio":
            messageText = "[Audio file attached]";
            break;
          default:
            messageText = "[Media attached]";
        }
      }
      logger.info(`Media received: ${data.media_type} at ${data.media_path}`);
    }

    if (!messageText.trim() && !mediaPath) {
      logVerbose("telegram-userbot: empty message, skipping");
      return;
    }

    // Check allowlist
    const allowedUsers = config.telegram.allowedUsers || [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(data.user_id)) {
      logInboundDrop({
        log: logVerbose,
        channel: "telegram-userbot",
        reason: "user not in allowlist",
        target: String(data.user_id),
      });
      return;
    }

    // Resolve agent route
    const senderId = String(data.user_id);
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "telegram-userbot",
      accountId,
      peer: {
        kind: "dm",
        id: senderId,
      },
    });

    // Format message envelope
    const senderName = data.username || `User ${data.user_id}`;
    const fromLabel = senderName;
    const rawBody = messageText;
    const messageId = String(data.message_id);
    
    const bodyWithMeta = `${rawBody}\n[telegram-userbot message_id: ${messageId}]`;

    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const timestamp = Date.now();
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "TelegramUserbot",
      from: fromLabel,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: bodyWithMeta,
    });

    // Build context payload
    const ctxPayload = {
      Body: body,
      BodyForAgent: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      BodyForCommands: rawBody,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      From: `telegram-userbot:${senderId}`,
      To: `telegram-userbot:${senderId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct" as const,
      ConversationLabel: fromLabel,
      SenderName: senderName,
      SenderId: senderId,
      SenderUsername: data.username,
      Provider: "telegram-userbot" as const,
      Surface: "telegram-userbot" as const,
      MessageSid: messageId,
      Timestamp: timestamp,
      OriginatingChannel: "telegram-userbot" as const,
      OriginatingTo: `telegram-userbot:${senderId}`,
      CommandAuthorized: true,
    };

    const outboundTarget = senderId;
    let sentMessage = false;

    // Typing/Recording indicator callbacks
    const responseAction = wantsVoiceResponse ? "record_audio" : "typing";
    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        try {
          await bridge.request("chat_action", { user_id: data.user_id, action_type: responseAction });
          logVerbose(`telegram-userbot: ${responseAction} started`);
        } catch (err) {
          logVerbose(`telegram-userbot: ${responseAction} start failed: ${err}`);
        }
      },
      stop: async () => {
        try {
          await bridge.request("chat_action", { user_id: data.user_id, action_type: "cancel" });
          logVerbose(`telegram-userbot: ${responseAction} stopped`);
        } catch (err) {
          logVerbose(`telegram-userbot: ${responseAction} stop failed: ${err}`);
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "telegram-userbot",
          action: "start",
          target: outboundTarget,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "telegram-userbot",
          action: "stop",
          target: outboundTarget,
          error: err,
        });
      },
    });

    logger.info(`Dispatching reply for session: ${route.sessionKey}`);
    
    try {
      await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            let text = payload.text ?? "";
            if (!text.trim()) {
              return;
            }
            
            // Check for language change tag [LANG:xx]
            const langMatch = text.match(/^\[LANG:(\w{2})\]\s*/i);
            if (langMatch && voiceServiceAvailable) {
              const newLang = langMatch[1].toLowerCase();
              logger.info(`Language change detected: ${newLang}`);
              try {
                await voiceClient.setLanguage(userId, newLang);
                logger.info(`Language set to ${newLang} for user ${userId}`);
              } catch (err) {
                logger.error(`Failed to set language: ${err}`);
              }
              // Remove the tag from the text
              text = text.replace(/^\[LANG:\w{2}\]\s*/i, "");
            }
            
            try {
              // Voice response if voice-to-voice mode and service available
              if (wantsVoiceResponse && voiceServiceAvailable) {
                // Strip markdown formatting for TTS (bold, italic, code, links, etc.)
                const cleanText = text
                  .replace(/\*\*(.+?)\*\*/g, "$1")     // **bold** -> bold
                  .replace(/\*(.+?)\*/g, "$1")         // *italic* -> italic
                  .replace(/__(.+?)__/g, "$1")         // __underline__ -> underline
                  .replace(/_(.+?)_/g, "$1")           // _italic_ -> italic
                  .replace(/~~(.+?)~~/g, "$1")         // ~~strike~~ -> strike
                  .replace(/`{3}[\s\S]*?`{3}/g, "")    // ```code blocks``` -> remove
                  .replace(/`(.+?)`/g, "$1")           // `inline code` -> text
                  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [link](url) -> link
                  .replace(/^#+\s+/gm, "")             // # headers -> remove #
                  .replace(/^\s*[-*+]\s+/gm, "")       // - bullets -> remove marker
                  .replace(/^\s*\d+\.\s+/gm, "")       // 1. numbered -> remove number
                  .replace(/\n{3,}/g, "\n\n")          // Multiple newlines -> double
                  .trim();
                
                logger.info(`Generating voice response via service: ${cleanText.substring(0, 50)}...`);
                try {
                  const audioResult = await voiceClient.synthesize(cleanText, userId);
                  
                  if (audioResult.error) {
                    throw new Error(audioResult.error);
                  }
                  
                  logger.info(`Sending voice note to ${data.user_id}`);
                  await bridge.request("send_voice", {
                    user_id: data.user_id,
                    audio_path: audioResult.audio_path,
                  });
                  sentMessage = true;
                  statusSink?.({ lastOutboundAt: Date.now() });
                  logger.info(`Voice sent successfully to ${senderId}`);
                } catch (ttsErr) {
                  logger.error(`TTS failed, falling back to text: ${ttsErr}`);
                  await bridge.request("send_text", {
                    user_id: data.user_id,
                    text: text,
                  });
                  sentMessage = true;
                  statusSink?.({ lastOutboundAt: Date.now() });
                }
              } else {
                // Regular text response
                logger.info(`Sending text to user ${data.user_id}: ${text.substring(0, 50)}...`);
                await bridge.request("send_text", {
                  user_id: data.user_id,
                  text: text,
                });
                sentMessage = true;
                statusSink?.({ lastOutboundAt: Date.now() });
                logger.info(`Text sent successfully to ${senderId}`);
              }
            } catch (err) {
              logger.error(`Failed to send reply: ${err}`);
              throw err;
            }
          },
          onReplyStart: typingCallbacks.onReplyStart,
          onIdle: typingCallbacks.onIdle,
        },
      });
      logger.info(`Dispatch completed, sentMessage=${sentMessage}`);
    } catch (err) {
      logger.error(`Dispatch failed: ${err}`);
    }

    if (sentMessage) {
      const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
      core.system.enqueueSystemEvent(
        `Telegram Userbot message from ${senderName}: ${preview}`,
        {
          sessionKey: route.sessionKey,
          contextKey: `telegram-userbot:message:${senderId}:${messageId}`,
        }
      );
    }
  }

  // Register message handlers
  bridge.on("message:private", handleIncomingMessage);
  bridge.on("message:voice", handleIncomingMessage);
  bridge.on("message:media", handleIncomingMessage);

  logger.info("telegram-userbot: monitor started");

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    if (opts.abortSignal?.aborted) {
      resolve();
      return;
    }
    opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });

  // Cleanup
  bridge.removeListener("message:private", handleIncomingMessage);
  bridge.removeListener("message:voice", handleIncomingMessage);
  bridge.removeListener("message:media", handleIncomingMessage);
  
  logger.info("telegram-userbot: monitor stopped");
}
