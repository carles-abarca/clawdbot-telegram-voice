/**
 * Telegram Userbot Plugin Configuration Types
 */

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
  modelPath?: string;
  language?: string;
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
}

// Re-export for backwards compatibility
export type TelegramVoiceConfig = TelegramUserbotConfig;
