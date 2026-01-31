/**
 * Telegram Userbot Plugin Configuration Types
 */
import { z } from "zod";
/**
 * Expand ~ to home directory in paths
 */
export declare function expandPath(p: string | undefined): string | undefined;
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
    detectModelPath?: string;
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
export declare const TelegramUserbotConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    apiId: z.ZodNumber;
    apiHash: z.ZodString;
    phone: z.ZodString;
    sessionPath: z.ZodOptional<z.ZodString>;
    pythonEnvPath: z.ZodOptional<z.ZodString>;
    allowedUsers: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    stt: z.ZodOptional<z.ZodObject<{
        provider: z.ZodDefault<z.ZodEnum<["whisper-cpp", "whisper-api"]>>;
        whisperPath: z.ZodOptional<z.ZodString>;
        modelPath: z.ZodOptional<z.ZodString>;
        language: z.ZodOptional<z.ZodString>;
        threads: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        provider: "whisper-cpp" | "whisper-api";
        whisperPath?: string | undefined;
        modelPath?: string | undefined;
        language?: string | undefined;
        threads?: number | undefined;
    }, {
        provider?: "whisper-cpp" | "whisper-api" | undefined;
        whisperPath?: string | undefined;
        modelPath?: string | undefined;
        language?: string | undefined;
        threads?: number | undefined;
    }>>;
    tts: z.ZodOptional<z.ZodObject<{
        provider: z.ZodDefault<z.ZodEnum<["piper", "openai", "elevenlabs"]>>;
        piperPath: z.ZodOptional<z.ZodString>;
        voicePath: z.ZodOptional<z.ZodString>;
        lengthScale: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        provider: "piper" | "openai" | "elevenlabs";
        piperPath?: string | undefined;
        voicePath?: string | undefined;
        lengthScale?: number | undefined;
    }, {
        provider?: "piper" | "openai" | "elevenlabs" | undefined;
        piperPath?: string | undefined;
        voicePath?: string | undefined;
        lengthScale?: number | undefined;
    }>>;
    name: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    apiId: number;
    apiHash: string;
    phone: string;
    sessionPath?: string | undefined;
    pythonEnvPath?: string | undefined;
    allowedUsers?: number[] | undefined;
    stt?: {
        provider: "whisper-cpp" | "whisper-api";
        whisperPath?: string | undefined;
        modelPath?: string | undefined;
        language?: string | undefined;
        threads?: number | undefined;
    } | undefined;
    tts?: {
        provider: "piper" | "openai" | "elevenlabs";
        piperPath?: string | undefined;
        voicePath?: string | undefined;
        lengthScale?: number | undefined;
    } | undefined;
    name?: string | undefined;
    accounts?: Record<string, any> | undefined;
}, {
    apiId: number;
    apiHash: string;
    phone: string;
    enabled?: boolean | undefined;
    sessionPath?: string | undefined;
    pythonEnvPath?: string | undefined;
    allowedUsers?: number[] | undefined;
    stt?: {
        provider?: "whisper-cpp" | "whisper-api" | undefined;
        whisperPath?: string | undefined;
        modelPath?: string | undefined;
        language?: string | undefined;
        threads?: number | undefined;
    } | undefined;
    tts?: {
        provider?: "piper" | "openai" | "elevenlabs" | undefined;
        piperPath?: string | undefined;
        voicePath?: string | undefined;
        lengthScale?: number | undefined;
    } | undefined;
    name?: string | undefined;
    accounts?: Record<string, any> | undefined;
}>;
export type TelegramVoiceConfig = TelegramUserbotConfig;
//# sourceMappingURL=config.d.ts.map