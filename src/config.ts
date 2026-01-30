/**
 * Telegram Userbot Plugin Configuration Types
 */

import { z } from "zod";
import os from "node:os";

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("~/")) {
    return p.replace("~", os.homedir());
  }
  if (p.startsWith("$HOME/")) {
    return p.replace("$HOME", os.homedir());
  }
  return p;
}

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  phone: string;
  sessionPath: string;
  pythonEnvPath: string;
  allowedUsers: number[];
}

export interface STTConfig {
  provider: "whisper-cpp" | "whisper-api";
  whisperPath?: string;
  modelPath?: string;           // Model for transcription (e.g., small)
  detectModelPath?: string;     // Model for language detection (e.g., medium) - optional
  language?: string;
  threads?: number;
}

export interface TTSConfig {
  provider: "piper" | "openai" | "elevenlabs";
  piperPath?: string;
  voicePath?: string;
  lengthScale?: number;
}

export interface TelegramUserbotConfig {
  enabled: boolean;
  telegram: TelegramConfig;
  stt?: STTConfig;
  tts?: TTSConfig;
  logPath?: string;
}

// Zod schema for config validation
export const TelegramUserbotConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiId: z.number(),
  apiHash: z.string(),
  phone: z.string(),
  sessionPath: z.string().optional(),
  pythonEnvPath: z.string().optional(),
  allowedUsers: z.array(z.number()).optional(),
  stt: z.object({
    provider: z.enum(["whisper-cpp", "whisper-api"]).default("whisper-cpp"),
    whisperPath: z.string().optional(),
    modelPath: z.string().optional(),
    language: z.string().optional(),
    threads: z.number().optional(),
  }).optional(),
  tts: z.object({
    provider: z.enum(["piper", "openai", "elevenlabs"]).default("piper"),
    piperPath: z.string().optional(),
    voicePath: z.string().optional(),
    lengthScale: z.number().optional(),
  }).optional(),
  name: z.string().optional(),
  accounts: z.record(z.any()).optional(),
});

// Re-export for backwards compatibility
export type TelegramVoiceConfig = TelegramUserbotConfig;
