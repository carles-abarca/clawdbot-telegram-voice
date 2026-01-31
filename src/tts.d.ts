/**
 * Telegram Voice Plugin - Text-to-Speech (Piper)
 */
import type { TTSConfig } from "./config.js";
import type { TTSResult, Logger } from "./types.js";
export declare class PiperTTS {
    private config;
    private logger;
    private tmpDir;
    private piperLibPath;
    constructor(config: TTSConfig, logger: Logger);
    /**
     * Check if Piper is available
     */
    isAvailable(): Promise<boolean>;
    /**
     * List available voices
     */
    listVoices(): string[];
    /**
     * Synthesize text to audio file
     */
    synthesize(text: string, outputPath?: string): Promise<TTSResult>;
    /**
     * Synthesize text to PCM buffer for streaming
     */
    synthesizeToBuffer(text: string, sampleRate?: number): Promise<Buffer>;
    /**
     * Convert WAV to raw PCM buffer
     */
    private wavToPcm;
    /**
     * Get audio duration using ffprobe
     */
    private getAudioDuration;
    /**
     * Convert audio for Telegram voice call (48kHz opus)
     */
    convertForTelegram(inputPath: string): Promise<string>;
    /**
     * Clean up temporary files
     */
    cleanup(): void;
}
//# sourceMappingURL=tts.d.ts.map