/**
 * Telegram Userbot Plugin Configuration Types
 */
import { z } from "zod";
import os from "node:os";
/**
 * Expand ~ to home directory in paths
 */
export function expandPath(p) {
    if (!p)
        return p;
    if (p.startsWith("~/")) {
        return p.replace("~", os.homedir());
    }
    if (p.startsWith("$HOME/")) {
        return p.replace("$HOME", os.homedir());
    }
    return p;
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
//# sourceMappingURL=config.js.map