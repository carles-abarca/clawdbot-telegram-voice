/**
 * Telegram Voice Plugin for Clawdbot
 * 
 * 100% local voice calls using:
 * - Whisper.cpp for STT (speech-to-text)
 * - Piper for TTS (text-to-speech)
 * - pytgcalls for Telegram voice calls
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  telegramVoiceConfigSchema,
  validateConfig,
  type TelegramVoiceConfig,
} from "./config.js";
import { TelegramBridge } from "./telegram-bridge.js";
import { WhisperSTT } from "./stt.js";
import { PiperTTS } from "./tts.js";
import { registerTelegramVoiceCli } from "./cli.js";
import type {
  CallRecord,
  TelegramVoiceRuntime,
  Logger,
  TranscriptEntry,
} from "./types.js";

// Tool parameter schema
const TelegramVoiceToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
  }),
  Type.Object({
    action: Type.Literal("end"),
    callId: Type.Optional(Type.String({ description: "Call ID (uses current if not specified)" })),
  }),
]);

/**
 * Create the voice call runtime
 */
async function createTelegramVoiceRuntime(params: {
  config: TelegramVoiceConfig;
  logger: Logger;
}): Promise<TelegramVoiceRuntime> {
  const { config, logger } = params;

  // Initialize components
  const bridge = new TelegramBridge(config.telegram, logger);
  const stt = new WhisperSTT(config.stt, logger);
  const tts = new PiperTTS(config.tts, logger);

  // Current call state
  let currentCall: CallRecord | null = null;
  let started = false;

  // Ensure log directory exists
  if (!fs.existsSync(config.logPath)) {
    fs.mkdirSync(config.logPath, { recursive: true });
  }

  // Log call events
  function logCall(call: CallRecord): void {
    const logPath = path.join(config.logPath, "calls.jsonl");
    const entry = JSON.stringify({ ...call, loggedAt: Date.now() }) + "\n";
    fs.appendFileSync(logPath, entry);
  }

  // Handle incoming audio from call
  async function handleAudioReceived(data: { audioPath: string }): Promise<void> {
    if (!currentCall) return;

    try {
      // Transcribe with Whisper
      const result = await stt.transcribe(data.audioPath);
      
      if (result.text.trim()) {
        // Add to transcript
        const entry: TranscriptEntry = {
          timestamp: Date.now(),
          speaker: "user",
          text: result.text,
        };
        currentCall.transcript.push(entry);

        logger.info(`User said: "${result.text}"`);

        // Emit event for Clawdbot to handle
        bridge.emit("speech", {
          callId: currentCall.callId,
          text: result.text,
          language: result.language,
        });
      }
    } catch (error) {
      logger.error(`Failed to transcribe audio: ${error}`);
    }
  }

  // Setup bridge event handlers
  bridge.on("audio:received", handleAudioReceived);

  bridge.on("call:joined", (data) => {
    logger.info(`Joined call with ${data.chat_id}`);
    if (currentCall) {
      currentCall.state = "active";
      currentCall.answeredAt = Date.now();
    }
  });

  bridge.on("call:left", (data) => {
    logger.info(`Left call with ${data.chat_id}`);
    if (currentCall) {
      currentCall.state = "ended";
      currentCall.endedAt = Date.now();
      logCall(currentCall);
      currentCall = null;
    }
  });

  bridge.on("call:kicked", (data) => {
    logger.warn(`Kicked from call ${data.chat_id}`);
    if (currentCall) {
      currentCall.state = "ended";
      currentCall.endReason = "hangup-user";
      currentCall.endedAt = Date.now();
      logCall(currentCall);
      currentCall = null;
    }
  });

  // Runtime object
  const runtime: TelegramVoiceRuntime = {
    config,
    bridge,
    stt,
    tts,

    async start(): Promise<void> {
      if (started) return;

      logger.info("Starting Telegram Voice runtime...");

      // Check STT/TTS availability
      const sttAvailable = await stt.isAvailable();
      const ttsAvailable = await tts.isAvailable();

      if (!sttAvailable) {
        logger.warn("Whisper STT not available - transcription disabled");
      }
      if (!ttsAvailable) {
        logger.warn("Piper TTS not available - synthesis disabled");
      }

      // Start bridge
      await bridge.start();
      started = true;

      logger.info("Telegram Voice runtime started");
    },

    async stop(): Promise<void> {
      if (!started) return;

      logger.info("Stopping Telegram Voice runtime...");

      // End current call
      if (currentCall) {
        await this.endCall(currentCall.callId);
      }

      // Stop bridge
      await bridge.stop();

      // Cleanup temp files
      stt.cleanup();
      tts.cleanup();

      started = false;
      logger.info("Telegram Voice runtime stopped");
    },

    getCurrentCall(): CallRecord | null {
      return currentCall;
    },

    async initiateCall(peerId: number): Promise<{ success: boolean; callId?: string; error?: string }> {
      if (currentCall) {
        return { success: false, error: "Already in a call" };
      }

      // Check if user is allowed
      if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(peerId)) {
        return { success: false, error: "User not in allowlist" };
      }

      const callId = randomUUID();
      currentCall = {
        callId,
        peerId,
        direction: "outbound",
        state: "initiating",
        startedAt: Date.now(),
        transcript: [],
      };

      try {
        await bridge.joinCall(peerId);
        return { success: true, callId };
      } catch (error) {
        currentCall = null;
        return { success: false, error: String(error) };
      }
    },

    async endCall(callId: string): Promise<{ success: boolean; error?: string }> {
      if (!currentCall || currentCall.callId !== callId) {
        return { success: false, error: "Call not found" };
      }

      try {
        await bridge.leaveCall();
        currentCall.state = "ended";
        currentCall.endReason = "hangup-bot";
        currentCall.endedAt = Date.now();
        logCall(currentCall);
        currentCall = null;
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };

  return runtime;
}

// Plugin definition
const telegramVoicePlugin = {
  id: "telegram-voice",
  name: "Telegram Voice",
  description: "Voice calls through Telegram with local STT/TTS (Whisper + Piper)",
  configSchema: telegramVoiceConfigSchema,

  register(api: {
    pluginConfig: unknown;
    logger: Logger;
    config: unknown;
    runtime: { tts?: unknown };
    registerGatewayMethod: (name: string, handler: (ctx: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown) => void }) => Promise<void>) => void;
    registerTool: (tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
    }) => void;
    registerCli: (handler: (ctx: { program: import("commander").Command }) => void, opts: { commands: string[] }) => void;
    registerService: (service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  }) {
    const cfg = telegramVoiceConfigSchema.parse(api.pluginConfig);
    const validation = validateConfig(cfg);

    if (!validation.valid) {
      for (const error of validation.errors) {
        api.logger.error(`[telegram-voice] Config error: ${error}`);
      }
    }
    for (const warning of validation.warnings) {
      api.logger.warn(`[telegram-voice] ${warning}`);
    }

    let runtimePromise: Promise<TelegramVoiceRuntime> | null = null;
    let runtime: TelegramVoiceRuntime | null = null;

    const ensureRuntime = async (): Promise<TelegramVoiceRuntime> => {
      if (!cfg.enabled) {
        throw new Error("Telegram Voice plugin is disabled");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createTelegramVoiceRuntime({
          config: cfg,
          logger: api.logger,
        });
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // Gateway methods
    api.registerGatewayMethod("telegram-voice.status", async ({ respond }) => {
      try {
        const rt = await ensureRuntime();
        const bridgeStatus = await rt.bridge.getStatus();
        respond(true, {
          ...bridgeStatus,
          bridgeConnected: rt.bridge.isConnected,
          currentCall: rt.getCurrentCall(),
        });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("telegram-voice.end", async ({ params, respond }) => {
      try {
        const rt = await ensureRuntime();
        const currentCall = rt.getCurrentCall();
        const callId = typeof params?.callId === "string" ? params.callId : currentCall?.callId;
        
        if (!callId) {
          respond(false, { error: "No active call" });
          return;
        }

        const result = await rt.endCall(callId);
        respond(result.success, result);
      } catch (err) {
        sendError(respond, err);
      }
    });

    // Tool registration
    api.registerTool({
      name: "telegram_voice_call",
      label: "Telegram Voice Call",
      description: "Manage Telegram voice calls",
      parameters: TelegramVoiceToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          if (params.action === "status") {
            const bridgeStatus = await rt.bridge.getStatus();
            return json({
              ...bridgeStatus,
              bridgeConnected: rt.bridge.isConnected,
              currentCall: rt.getCurrentCall(),
            });
          }

          if (params.action === "end") {
            const currentCall = rt.getCurrentCall();
            const callId = typeof params.callId === "string" ? params.callId : currentCall?.callId;
            
            if (!callId) {
              return json({ success: false, error: "No active call" });
            }

            const result = await rt.endCall(callId);
            return json(result);
          }

          return json({ error: "Unknown action" });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // CLI registration
    api.registerCli(
      ({ program }) =>
        registerTelegramVoiceCli({
          program,
          config: cfg,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["telegram-voice"] },
    );

    // Service registration
    api.registerService({
      id: "telegram-voice",
      start: async () => {
        if (!cfg.enabled) return;
        try {
          await ensureRuntime();
          const rt = await runtimePromise!;
          await rt.start();
        } catch (err) {
          api.logger.error(
            `[telegram-voice] Failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) return;
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default telegramVoicePlugin;
