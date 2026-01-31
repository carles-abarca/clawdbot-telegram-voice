/**
 * Telegram Voice Plugin - Speech-to-Text (Whisper.cpp)
 */
import type { STTConfig } from "./config.js";
import type { STTResult, Logger } from "./types.js";
export declare class WhisperSTT {
    private config;
    private logger;
    private tmpDir;
    constructor(config: STTConfig, logger: Logger);
    /**
     * Check if Whisper.cpp is available
     */
    isAvailable(): Promise<boolean>;
    /**
     * Detect language using a larger model (if configured)
     */
    private detectLanguage;
    /**
     * Transcribe audio file to text
     */
    transcribe(audioPath: string): Promise<STTResult>;
    /**
     * Transcribe raw PCM audio buffer
     */
    transcribeBuffer(buffer: Buffer, sampleRate?: number): Promise<STTResult>;
    /**
     * Convert audio to 16kHz mono WAV format required by Whisper
     */
    private ensureWavFormat;
    /**
     * Convert raw PCM to WAV
     */
    private pcmToWav;
    /**
     * Clean up temporary files
     */
    cleanup(): void;
}
//# sourceMappingURL=stt.d.ts.map