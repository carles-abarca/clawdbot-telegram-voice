/**
 * Telegram Voice Plugin - Configuration
 */

import { z } from "zod";
import path from "node:path";
import os from "node:os";

// -----------------------------------------------------------------------------
// STT Configuration (Whisper.cpp)
// -----------------------------------------------------------------------------

export const STTConfigSchema = z.object({
  provider: z.enum(["whisper-cpp", "whisper-api"]).default("whisper-cpp"),
  whisperPath: z
    .string()
    .default(path.join(os.homedir(), "whisper.cpp/build/bin/whisper-cli")),
  modelPath: z
    .string()
    .default(path.join(os.homedir(), "whisper.cpp/models/ggml-small.bin")),
  language: z.string().default("auto"),
  threads: z.number().int().positive().default(4),
});

export type STTConfig = z.infer<typeof STTConfigSchema>;

// -----------------------------------------------------------------------------
// TTS Configuration (Piper)
// -----------------------------------------------------------------------------

export const TTSConfigSchema = z.object({
  provider: z.enum(["piper", "openai", "elevenlabs"]).default("piper"),
  piperPath: z.string().default(path.join(os.homedir(), "piper/piper/piper")),
  voicePath: z
    .string()
    .default(path.join(os.homedir(), "piper/voices/ca_ES-upc_ona-medium.onnx")),
  // For cloud providers
  openaiApiKey: z.string().optional(),
  openaiVoice: z.string().default("nova"),
  elevenlabsApiKey: z.string().optional(),
  elevenlabsVoiceId: z.string().optional(),
});

export type TTSConfig = z.infer<typeof TTSConfigSchema>;

// -----------------------------------------------------------------------------
// Telegram Configuration
// -----------------------------------------------------------------------------

export const TelegramConfigSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().min(1),
  phone: z.string().regex(/^\+\d+$/, "Expected phone in E.164 format"),
  sessionPath: z
    .string()
    .default(path.join(os.homedir(), "jarvis-voice/jarvis_userbot.session")),
  pythonEnvPath: z
    .string()
    .default(path.join(os.homedir(), "jarvis-voice-env")),
});

export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

// -----------------------------------------------------------------------------
// Main Configuration
// -----------------------------------------------------------------------------

export const TelegramVoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  
  telegram: TelegramConfigSchema,
  stt: STTConfigSchema.default({}),
  tts: TTSConfigSchema.default({}),
  
  // Security
  allowedUsers: z.array(z.number()).default([]),
  autoAnswer: z.boolean().default(true),
  
  // Timeouts
  maxCallDurationMs: z.number().int().positive().default(300000), // 5 minutes
  silenceTimeoutMs: z.number().int().positive().default(3000),
  responseTimeoutMs: z.number().int().positive().default(30000),
  
  // Audio settings
  audioSampleRate: z.number().int().positive().default(48000),
  audioChannels: z.number().int().positive().default(1),
  
  // Logging
  logPath: z.string().default(path.join(os.homedir(), "clawd/telegram-voice")),
});

export type TelegramVoiceConfig = z.infer<typeof TelegramVoiceConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Parser
// -----------------------------------------------------------------------------

export const telegramVoiceConfigSchema = {
  parse(value: unknown): TelegramVoiceConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return TelegramVoiceConfigSchema.parse(raw);
  },
  
  uiHints: {
    enabled: { label: "Enable Plugin" },
    "telegram.apiId": { label: "Telegram API ID", help: "Get from my.telegram.org" },
    "telegram.apiHash": { label: "Telegram API Hash", sensitive: true },
    "telegram.phone": { label: "Phone Number", placeholder: "+34612345678" },
    "telegram.sessionPath": { label: "Session File Path", advanced: true },
    "telegram.pythonEnvPath": { label: "Python Environment", advanced: true },
    "stt.provider": { label: "STT Provider" },
    "stt.whisperPath": { label: "Whisper CLI Path", advanced: true },
    "stt.modelPath": { label: "Whisper Model Path", advanced: true },
    "stt.language": { label: "Language", help: "auto, ca, es, en..." },
    "tts.provider": { label: "TTS Provider" },
    "tts.piperPath": { label: "Piper Path", advanced: true },
    "tts.voicePath": { label: "Voice Model Path", advanced: true },
    allowedUsers: { label: "Allowed User IDs", help: "Empty = allow all" },
    autoAnswer: { label: "Auto Answer Calls" },
    maxCallDurationMs: { label: "Max Call Duration (ms)", advanced: true },
  },
};

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(config: TelegramVoiceConfig): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [], warnings: [] };
  }

  // Telegram credentials
  if (!config.telegram.apiId) {
    errors.push("telegram.apiId is required");
  }
  if (!config.telegram.apiHash) {
    errors.push("telegram.apiHash is required");
  }
  if (!config.telegram.phone) {
    errors.push("telegram.phone is required");
  }

  // Security warning
  if (config.allowedUsers.length === 0) {
    warnings.push("allowedUsers is empty - anyone can call!");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Default Configuration
// -----------------------------------------------------------------------------

export function getDefaultConfig(): Partial<TelegramVoiceConfig> {
  return {
    enabled: true,
    stt: {
      provider: "whisper-cpp",
      whisperPath: path.join(os.homedir(), "whisper.cpp/build/bin/whisper-cli"),
      modelPath: path.join(os.homedir(), "whisper.cpp/models/ggml-small.bin"),
      language: "auto",
      threads: 4,
    },
    tts: {
      provider: "piper",
      piperPath: path.join(os.homedir(), "piper/piper/piper"),
      voicePath: path.join(os.homedir(), "piper/voices/ca_ES-upc_ona-medium.onnx"),
      openaiVoice: "nova",
    },
    autoAnswer: true,
    maxCallDurationMs: 300000,
    silenceTimeoutMs: 3000,
    responseTimeoutMs: 30000,
    audioSampleRate: 48000,
    audioChannels: 1,
  };
}
