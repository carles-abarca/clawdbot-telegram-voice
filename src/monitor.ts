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
import { storeVoiceContext, consumeVoiceContext, hasVoiceContext } from "./voice-context.js";

/**
 * Split text into chunks for TTS, respecting sentence boundaries
 * to ensure natural-sounding audio segments
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining.trim());
      break;
    }
    
    // Try to find a sentence break (. ! ?) within the limit
    let splitPoint = -1;
    const searchRange = remaining.substring(0, maxChars);
    
    // Look for sentence endings
    const sentenceEndings = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
    for (const ending of sentenceEndings) {
      const lastIndex = searchRange.lastIndexOf(ending);
      if (lastIndex > splitPoint) {
        splitPoint = lastIndex + ending.length - 1;
      }
    }
    
    // If no sentence break, try comma or semicolon
    if (splitPoint < maxChars * 0.3) {
      const commaIndex = searchRange.lastIndexOf(', ');
      const semicolonIndex = searchRange.lastIndexOf('; ');
      splitPoint = Math.max(splitPoint, commaIndex, semicolonIndex);
      if (splitPoint > 0) splitPoint += 1;
    }
    
    // If still no good break point, just split at max chars
    if (splitPoint < maxChars * 0.3) {
      // Try to split at a space
      const spaceIndex = searchRange.lastIndexOf(' ');
      splitPoint = spaceIndex > 0 ? spaceIndex : maxChars;
    }
    
    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }
  
  return chunks.filter(c => c.length > 0);
}

// Queue functions will be loaded dynamically at runtime
let enqueueFollowupRun: ((key: string, run: any, settings: any) => boolean) | null = null;
let scheduleFollowupDrain: ((key: string, runFollowup: (run: any) => Promise<void>) => void) | null = null;
let queueFunctionsLoaded = false;

async function loadQueueFunctions() {
  if (queueFunctionsLoaded) return;
  try {
    // Import queue module using absolute path (bypasses exports restrictions)
    // This allows us to properly queue messages with originating channel info
    const clawdbotPath = await findClawdbotPath();
    if (clawdbotPath) {
      const queuePath = `${clawdbotPath}/dist/auto-reply/reply/queue.js`;
      const queueModule = await import(queuePath);
      enqueueFollowupRun = queueModule.enqueueFollowupRun;
      scheduleFollowupDrain = queueModule.scheduleFollowupDrain;
      console.log(`[telegram-userbot] Queue functions loaded successfully from ${queuePath}`);
    } else {
      throw new Error("Could not find clawdbot installation path");
    }
    queueFunctionsLoaded = true;
  } catch (err) {
    // Queue functions not available, will fall back to system events
    console.log(`[telegram-userbot] Queue functions not available (fallback to system events): ${err}`);
    queueFunctionsLoaded = true;
  }
}

async function findClawdbotPath(): Promise<string | null> {
  const { existsSync, readdirSync } = await import("fs");
  const home = process.env.HOME || "";
  
  // Try common installation paths
  const staticPaths = [
    // Global npm without nvm
    "/usr/local/lib/node_modules/clawdbot",
    "/usr/lib/node_modules/clawdbot",
  ];
  
  for (const p of staticPaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  
  // Check nvm versions directory (any version)
  const nvmVersionsDir = `${home}/.nvm/versions/node`;
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir);
      for (const ver of versions) {
        const clawdbotPath = `${nvmVersionsDir}/${ver}/lib/node_modules/clawdbot`;
        if (existsSync(clawdbotPath)) {
          return clawdbotPath;
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  
  return null;
}

export type MonitorOptions = {
  bridge: TelegramBridge;
  config: TelegramUserbotConfig;
  accountId: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
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
  const { bridge, config, accountId, statusSink, log } = opts;
  
  // Try to load queue functions for proper message routing
  await loadQueueFunctions();
  
  // Use passed logger or fallback to console
  const logger = log ?? {
    info: (msg: string) => console.log(`[telegram-userbot] ${msg}`),
    warn: (msg: string) => console.warn(`[telegram-userbot] ${msg}`),
    error: (msg: string) => console.error(`[telegram-userbot] ${msg}`),
    debug: (msg: string) => console.debug(`[telegram-userbot] ${msg}`),
  };
  
  const logVerbose = (message: string) => {
    logger.debug(message);
  };
  
  // Get runtime - if not available, we can't process messages
  let core: ReturnType<typeof getTelegramUserbotRuntime>;
  try {
    core = getTelegramUserbotRuntime();
  } catch (err) {
    logger.error(`Runtime not available: ${err}`);
    logger.error("Cannot start monitor without runtime - check plugin initialization");
    return;
  }
  
  const cfg = core.config.loadConfig();

  // Get voice service client
  logger.info("Checking voice service availability...");
  const voiceClient = getVoiceClient();
  let voiceServiceAvailable = false;
  
  // Check if voice service is available
  try {
    voiceServiceAvailable = await voiceClient.isAvailable();
    logger.info(`Voice service check result: ${voiceServiceAvailable}`);
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
        
        // SEMPRE voice-to-voice per notes de veu
        wantsVoiceResponse = true;
        logger.info(`Voice-to-voice: transcribed (lang=${result.language})`);
        
        // Store voice context in case session is busy and we need TTS later
        storeVoiceContext({
          userId,
          messageId: String(data.message_id),
          language: result.language || "ca",
          timestamp: Date.now(),
          wantsVoiceResponse: true,
        });
        logger.debug(`Voice context stored for user ${userId}`);
        
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
      
      // Start recording audio action (voice response incoming)
      const nextAction = "record_audio";
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
              // Check if there's pending voice context (for queued messages)
              let useVoiceResponse = wantsVoiceResponse;
              let pendingVoiceCtx = null;
              if (!useVoiceResponse && voiceServiceAvailable) {
                pendingVoiceCtx = consumeVoiceContext(userId);
                if (pendingVoiceCtx) {
                  useVoiceResponse = true;
                  logger.info(`Using pending voice context for user ${userId} (lang=${pendingVoiceCtx.language})`);
                }
              }
              
              // Voice response if voice-to-voice mode and service available
              if (useVoiceResponse && voiceServiceAvailable) {
                // Strip markdown formatting and emojis for TTS
                const cleanText = text
                  // Remove emojis
                  .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1FA00}-\u{1FAFF}]/gu, "")
                  // Markdown formatting
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
                  // Clean up remaining artifacts
                  .replace(/\*+/g, "")                 // Stray asterisks
                  .replace(/_+/g, " ")                 // Stray underscores -> space
                  .replace(/\|/g, ",")                 // Table pipes -> commas
                  .replace(/---+/g, "")                // Horizontal rules
                  .replace(/\n{3,}/g, "\n\n")          // Multiple newlines -> double
                  .replace(/\s{2,}/g, " ")             // Multiple spaces -> single
                  .trim();
                
                // Split long text into chunks to avoid memory issues
                const MAX_CHUNK_CHARS = 800;
                const textChunks = splitTextIntoChunks(cleanText, MAX_CHUNK_CHARS);
                
                logger.info(`Generating voice response via service: ${textChunks.length} chunk(s), total ${cleanText.length} chars`);
                
                let allChunksSent = true;
                for (let i = 0; i < textChunks.length; i++) {
                  const chunk = textChunks[i];
                  logger.info(`Processing chunk ${i + 1}/${textChunks.length}: ${chunk.substring(0, 40)}...`);
                  
                  try {
                    // Check memory before synthesis
                    const memCheck = await voiceClient.checkMemory?.();
                    if (memCheck?.lowMemory) {
                      logger.warn(`Low memory detected (${memCheck.availableMB}MB), restarting voice service...`);
                      await voiceClient.restartService?.();
                      await new Promise(r => setTimeout(r, 2000)); // Wait for restart
                    }
                    
                    const audioResult = await voiceClient.synthesize(chunk, userId);
                    
                    if (audioResult.error) {
                      throw new Error(audioResult.error);
                    }
                    
                    logger.info(`Sending voice note chunk ${i + 1} to ${data.user_id}`);
                    await bridge.request("send_voice", {
                      user_id: data.user_id,
                      audio_path: audioResult.audio_path,
                    });
                    statusSink?.({ lastOutboundAt: Date.now() });
                    
                    // Small delay between chunks
                    if (i < textChunks.length - 1) {
                      await new Promise(r => setTimeout(r, 500));
                    }
                  } catch (chunkErr) {
                    logger.error(`TTS failed for chunk ${i + 1}: ${chunkErr}`);
                    allChunksSent = false;
                    // Send remaining as text
                    const remainingText = textChunks.slice(i).join(" ");
                    await bridge.request("send_text", {
                      user_id: data.user_id,
                      text: remainingText,
                    });
                    break;
                  }
                }
                
                sentMessage = true;
                if (allChunksSent) {
                  logger.info(`All ${textChunks.length} voice chunks sent successfully to ${senderId}`);
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

    // If no message was sent (session was busy), queue it properly with originating channel
    if (!sentMessage) {
      logger.warn(`No response sent (session may be busy), queueing message for processing`);
      
      // Try to use proper followup queue with originating channel info
      if (enqueueFollowupRun && scheduleFollowupDrain) {
        const queueKey = route.sessionKey;
        const followupRun = {
          prompt: `[TelegramUserbot ${senderName}${isVoiceMessage ? " 🎤" : ""}] ${rawBody}\n[message_id: ${messageId}]`,
          messageId: messageId,
          summaryLine: `${senderName}: ${rawBody.substring(0, 50)}...`,
          run: {
            sessionKey: route.sessionKey,
            channel: "telegram-userbot",
            accountId: route.accountId,
          },
          originatingChannel: "telegram-userbot",
          originatingTo: `telegram-userbot:${senderId}`,
          originatingAccountId: route.accountId,
          enqueuedAt: Date.now(),
        };
        
        const queued = enqueueFollowupRun(queueKey, followupRun, { mode: "collect" });
        if (queued) {
          logger.info(`Message queued with originatingChannel=telegram-userbot for user ${senderId}`);
          // Schedule drain to process the queue when ready
          scheduleFollowupDrain(queueKey, async (run) => {
            logger.info(`Processing queued message for ${senderId}`);
            // The response will be routed back to telegram-userbot channel
          });
        } else {
          logger.warn(`Failed to queue message (duplicate or dropped)`);
        }
      } else {
        // Fallback to system event if queue functions not available
        // Format the message so it looks like it came from telegram-userbot channel
        // This should trigger the correct routing when processed
        const preview = rawBody.replace(/\s+/g, " ").slice(0, 200);
        const formattedMessage = `[TelegramUserbot ${senderName}${isVoiceMessage ? " (voice)" : ""} +0s] ${preview}\n[telegram-userbot message_id: ${messageId}]`;
        core.system.enqueueSystemEvent(
          formattedMessage,
          {
            sessionKey: route.sessionKey,
            contextKey: `telegram-userbot:pending:${senderId}:${messageId}`,
          }
        );
        logger.info(`Message queued as system event (fallback) for user ${senderId}`);
      }
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
