/**
 * Telegram Voice Plugin - Speech-to-Text (Whisper.cpp)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { STTConfig } from "./config.js";
import type { STTResult, Logger } from "./types.js";

export class WhisperSTT {
  private config: STTConfig;
  private logger: Logger;
  private tmpDir: string;

  constructor(config: STTConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.tmpDir = path.join(os.tmpdir(), "telegram-voice-stt");

    // Ensure tmp directory exists
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  /**
   * Check if Whisper.cpp is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.whisperPath || !this.config.modelPath) {
        this.logger.error("Whisper paths not configured");
        return false;
      }

      const whisperExists = fs.existsSync(this.config.whisperPath);
      const modelExists = fs.existsSync(this.config.modelPath);

      if (!whisperExists) {
        this.logger.error(`Whisper CLI not found at: ${this.config.whisperPath}`);
        return false;
      }
      if (!modelExists) {
        this.logger.error(`Whisper model not found at: ${this.config.modelPath}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to check Whisper availability: ${error}`);
      return false;
    }
  }

  /**
   * Transcribe audio file to text
   */
  async transcribe(audioPath: string): Promise<STTResult> {
    if (!this.config.whisperPath || !this.config.modelPath) {
      throw new Error("Whisper paths not configured");
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    // Convert to WAV if needed (Whisper expects 16kHz mono WAV)
    const wavPath = await this.ensureWavFormat(audioPath);
    const whisperPath = this.config.whisperPath;
    const modelPath = this.config.modelPath;
    const threads = this.config.threads ?? 4;

    return new Promise((resolve, reject) => {
      const args = [
        "-m", modelPath,
        "-f", wavPath,
        "-t", String(threads),
        "--no-timestamps",
        "-otxt",
      ];

      // Add language if specified
      if (this.config.language && this.config.language !== "auto") {
        args.push("-l", this.config.language);
      }

      this.logger.debug(`Running Whisper: ${whisperPath} ${args.join(" ")}`);

      const startTime = Date.now();
      let stdout = "";
      let stderr = "";

      const proc = spawn(whisperPath, args);

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        const duration = (Date.now() - startTime) / 1000;

        // Clean up temp WAV if we created it
        if (wavPath !== audioPath && fs.existsSync(wavPath)) {
          fs.unlinkSync(wavPath);
        }

        if (code !== 0) {
          this.logger.error(`Whisper failed with code ${code}: ${stderr}`);
          reject(new Error(`Whisper failed: ${stderr}`));
          return;
        }

        // Parse output - Whisper outputs text directly
        const text = stdout.trim();

        // Try to detect language from stderr (Whisper logs it)
        let language: string | undefined;
        const langMatch = stderr.match(/auto-detected language: (\w+)/);
        if (langMatch) {
          language = langMatch[1];
        }

        this.logger.info(`Transcribed in ${duration.toFixed(2)}s: "${text.substring(0, 50)}..."`);

        resolve({
          text,
          language,
          duration,
        });
      });

      proc.on("error", (error) => {
        reject(new Error(`Failed to spawn Whisper: ${error.message}`));
      });
    });
  }

  /**
   * Transcribe raw PCM audio buffer
   */
  async transcribeBuffer(buffer: Buffer, sampleRate = 48000): Promise<STTResult> {
    // Save buffer to temp file
    const tempPath = path.join(this.tmpDir, `audio_${Date.now()}.pcm`);
    fs.writeFileSync(tempPath, buffer);

    try {
      // Convert PCM to WAV
      const wavPath = await this.pcmToWav(tempPath, sampleRate);
      const result = await this.transcribe(wavPath);

      // Cleanup
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

      return result;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  /**
   * Convert audio to 16kHz mono WAV format required by Whisper
   */
  private async ensureWavFormat(inputPath: string): Promise<string> {
    const ext = path.extname(inputPath).toLowerCase();

    // If already WAV, check format
    if (ext === ".wav") {
      // For now, assume it needs conversion to be safe
      // TODO: Check WAV header for sample rate
    }

    const outputPath = path.join(this.tmpDir, `converted_${Date.now()}.wav`);

    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i", inputPath,
        "-ar", "16000",  // 16kHz sample rate
        "-ac", "1",      // Mono
        "-c:a", "pcm_s16le",  // 16-bit PCM
        outputPath,
      ];

      const proc = spawn("ffmpeg", args);

      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          this.logger.error(`FFmpeg conversion failed: ${stderr}`);
          reject(new Error(`FFmpeg failed with code ${code}`));
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
   * Convert raw PCM to WAV
   */
  private async pcmToWav(pcmPath: string, sampleRate: number): Promise<string> {
    const outputPath = path.join(this.tmpDir, `pcm_converted_${Date.now()}.wav`);

    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-f", "s16le",      // Input format: signed 16-bit little-endian
        "-ar", String(sampleRate),
        "-ac", "1",         // Mono
        "-i", pcmPath,
        "-ar", "16000",     // Output 16kHz for Whisper
        "-ac", "1",
        "-c:a", "pcm_s16le",
        outputPath,
      ];

      const proc = spawn("ffmpeg", args);

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg PCM conversion failed with code ${code}`));
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
  cleanup(): void {
    try {
      if (fs.existsSync(this.tmpDir)) {
        const files = fs.readdirSync(this.tmpDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tmpDir, file));
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup STT temp files: ${error}`);
    }
  }
}
