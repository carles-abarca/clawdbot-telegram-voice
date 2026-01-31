/**
 * Telegram Voice Plugin - Text-to-Speech (Piper)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
export class PiperTTS {
    config;
    logger;
    tmpDir;
    piperLibPath;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.tmpDir = path.join(os.tmpdir(), "telegram-voice-tts");
        // Piper needs its lib directory in LD_LIBRARY_PATH
        this.piperLibPath = this.config.piperPath ? path.dirname(this.config.piperPath) : "";
        // Ensure tmp directory exists
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
    }
    /**
     * Check if Piper is available
     */
    async isAvailable() {
        try {
            if (!this.config.piperPath || !this.config.voicePath) {
                this.logger.error("Piper paths not configured");
                return false;
            }
            const piperExists = fs.existsSync(this.config.piperPath);
            const voiceExists = fs.existsSync(this.config.voicePath);
            if (!piperExists) {
                this.logger.error(`Piper not found at: ${this.config.piperPath}`);
                return false;
            }
            if (!voiceExists) {
                this.logger.error(`Piper voice not found at: ${this.config.voicePath}`);
                return false;
            }
            return true;
        }
        catch (error) {
            this.logger.error(`Failed to check Piper availability: ${error}`);
            return false;
        }
    }
    /**
     * List available voices
     */
    listVoices() {
        if (!this.config.voicePath) {
            return [];
        }
        const voicesDir = path.dirname(this.config.voicePath);
        if (!fs.existsSync(voicesDir)) {
            return [];
        }
        return fs
            .readdirSync(voicesDir)
            .filter((f) => f.endsWith(".onnx"))
            .map((f) => f.replace(".onnx", ""));
    }
    /**
     * Synthesize text to audio file
     */
    async synthesize(text, outputPath) {
        if (!this.config.piperPath || !this.config.voicePath) {
            throw new Error("Piper paths not configured");
        }
        if (!text.trim()) {
            throw new Error("Empty text provided for TTS");
        }
        const audioPath = outputPath || path.join(this.tmpDir, `tts_${Date.now()}.wav`);
        const piperPath = this.config.piperPath;
        const voicePath = this.config.voicePath;
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const args = [
                "--model", voicePath,
                "--output_file", audioPath,
            ];
            this.logger.debug(`Running Piper: echo "${text.substring(0, 30)}..." | piper ${args.join(" ")}`);
            const proc = spawn(piperPath, args, {
                env: {
                    ...process.env,
                    LD_LIBRARY_PATH: `${this.piperLibPath}:${process.env.LD_LIBRARY_PATH || ""}`,
                },
            });
            let stderr = "";
            proc.stderr?.on("data", (data) => {
                stderr += data.toString();
            });
            // Write text to stdin
            proc.stdin?.write(text);
            proc.stdin?.end();
            proc.on("close", (code) => {
                const duration = (Date.now() - startTime) / 1000;
                if (code !== 0) {
                    this.logger.error(`Piper failed with code ${code}: ${stderr}`);
                    reject(new Error(`Piper failed: ${stderr}`));
                    return;
                }
                if (!fs.existsSync(audioPath)) {
                    reject(new Error("Piper did not create output file"));
                    return;
                }
                this.logger.info(`Synthesized in ${duration.toFixed(2)}s: "${text.substring(0, 50)}..."`);
                // Get audio duration using ffprobe
                this.getAudioDuration(audioPath)
                    .then((audioDuration) => {
                    resolve({
                        audioPath,
                        duration: audioDuration,
                    });
                })
                    .catch(() => {
                    // If we can't get duration, still return success
                    resolve({
                        audioPath,
                    });
                });
            });
            proc.on("error", (error) => {
                reject(new Error(`Failed to spawn Piper: ${error.message}`));
            });
        });
    }
    /**
     * Synthesize text to PCM buffer for streaming
     */
    async synthesizeToBuffer(text, sampleRate = 48000) {
        // First synthesize to WAV
        const wavPath = path.join(this.tmpDir, `tts_${Date.now()}.wav`);
        await this.synthesize(text, wavPath);
        // Convert to raw PCM at desired sample rate
        const pcmBuffer = await this.wavToPcm(wavPath, sampleRate);
        // Cleanup WAV
        if (fs.existsSync(wavPath)) {
            fs.unlinkSync(wavPath);
        }
        return pcmBuffer;
    }
    /**
     * Convert WAV to raw PCM buffer
     */
    async wavToPcm(wavPath, sampleRate) {
        const pcmPath = wavPath.replace(".wav", ".pcm");
        return new Promise((resolve, reject) => {
            const args = [
                "-y",
                "-i", wavPath,
                "-f", "s16le",
                "-ar", String(sampleRate),
                "-ac", "1",
                pcmPath,
            ];
            const proc = spawn("ffmpeg", args);
            proc.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`FFmpeg PCM conversion failed with code ${code}`));
                    return;
                }
                const buffer = fs.readFileSync(pcmPath);
                fs.unlinkSync(pcmPath);
                resolve(buffer);
            });
            proc.on("error", (error) => {
                reject(new Error(`Failed to spawn ffmpeg: ${error.message}`));
            });
        });
    }
    /**
     * Get audio duration using ffprobe
     */
    async getAudioDuration(audioPath) {
        return new Promise((resolve, reject) => {
            const args = [
                "-v", "quiet",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                audioPath,
            ];
            const proc = spawn("ffprobe", args);
            let stdout = "";
            proc.stdout.on("data", (data) => {
                stdout += data.toString();
            });
            proc.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error("ffprobe failed"));
                    return;
                }
                resolve(parseFloat(stdout.trim()));
            });
            proc.on("error", reject);
        });
    }
    /**
     * Convert audio for Telegram voice call (48kHz opus)
     */
    async convertForTelegram(inputPath) {
        const outputPath = inputPath.replace(/\.\w+$/, "_telegram.ogg");
        return new Promise((resolve, reject) => {
            const args = [
                "-y",
                "-i", inputPath,
                "-c:a", "libopus",
                "-ar", "48000",
                "-ac", "1",
                "-b:a", "64k",
                outputPath,
            ];
            const proc = spawn("ffmpeg", args);
            proc.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`FFmpeg opus conversion failed with code ${code}`));
                    return;
                }
                resolve(outputPath);
            });
            proc.on("error", (error) => {
                reject(new Error(`Failed to spawn ffmpeg: ${error.message}`));
            });
        });
    }
    /**
     * Clean up temporary files
     */
    cleanup() {
        try {
            if (fs.existsSync(this.tmpDir)) {
                const files = fs.readdirSync(this.tmpDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(this.tmpDir, file));
                }
            }
        }
        catch (error) {
            this.logger.warn(`Failed to cleanup TTS temp files: ${error}`);
        }
    }
}
//# sourceMappingURL=tts.js.map