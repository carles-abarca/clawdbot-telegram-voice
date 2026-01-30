/**
 * Telegram Voice Plugin - CLI Commands
 */

import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

import type { TelegramVoiceConfig } from "./config.js";
import type { TelegramVoiceRuntime, Logger } from "./types.js";

export function registerTelegramVoiceCli(params: {
  program: Command;
  config: TelegramVoiceConfig;
  ensureRuntime: () => Promise<TelegramVoiceRuntime>;
  logger: Logger;
}): void {
  const { program, config, ensureRuntime, logger } = params;

  const root = program
    .command("telegram-voice")
    .description("Telegram voice call utilities")
    .addHelpText("after", () => "\nDocs: https://github.com/carles-abarca/clawdbot-telegram-voice\n");

  // Status command
  root
    .command("status")
    .description("Show connection status and current call info")
    .action(async () => {
      try {
        const rt = await ensureRuntime();
        const bridgeStatus = await rt.bridge.getStatus();
        const currentCall = rt.getCurrentCall();

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          enabled: config.enabled,
          bridge: {
            ...bridgeStatus,
            bridgeConnected: rt.bridge.isConnected,
          },
          currentCall: currentCall || null,
          stt: config.stt ? {
            provider: config.stt.provider,
            available: await rt.stt.isAvailable(),
          } : { provider: "not configured", available: false },
          tts: config.tts ? {
            provider: config.tts.provider,
            available: await rt.tts.isAvailable(),
          } : { provider: "not configured", available: false },
        }, null, 2));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  // Test STT command
  root
    .command("test-stt")
    .description("Test speech-to-text with an audio file")
    .requiredOption("-f, --file <path>", "Path to audio file")
    .option("-l, --language <lang>", "Language code (auto, ca, es, en...)")
    .action(async (options: { file: string; language?: string }) => {
      try {
        const rt = await ensureRuntime();

        if (!fs.existsSync(options.file)) {
          throw new Error(`File not found: ${options.file}`);
        }

        logger.info(`Transcribing: ${options.file}`);
        const result = await rt.stt.transcribe(options.file);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          success: true,
          text: result.text,
          language: result.language,
          duration: result.duration,
        }, null, 2));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  // Test TTS command
  root
    .command("test-tts")
    .description("Test text-to-speech")
    .requiredOption("-t, --text <text>", "Text to synthesize")
    .option("-o, --output <path>", "Output file path (default: temp file)")
    .option("-p, --play", "Play audio after synthesis")
    .action(async (options: { text: string; output?: string; play?: boolean }) => {
      try {
        const rt = await ensureRuntime();

        logger.info(`Synthesizing: "${options.text.substring(0, 50)}..."`);
        const result = await rt.tts.synthesize(options.text, options.output);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          success: true,
          audioPath: result.audioPath,
          duration: result.duration,
        }, null, 2));

        if (options.play) {
          const { spawn } = await import("node:child_process");
          spawn("aplay", [result.audioPath], { stdio: "inherit" });
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  // List voices command
  root
    .command("voices")
    .description("List available TTS voices")
    .action(async () => {
      try {
        const rt = await ensureRuntime();
        const voices = rt.tts.listVoices();

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          provider: config.tts?.provider ?? "not configured",
          currentVoice: config.tts?.voicePath ? path.basename(config.tts.voicePath).replace(".onnx", "") : "none",
          availableVoices: voices,
        }, null, 2));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  // Auth command (for initial setup)
  root
    .command("auth")
    .description("Authenticate with Telegram (run during initial setup)")
    .action(async () => {
      logger.info("Telegram authentication is handled through the Python userbot session.");
      logger.info(`Session path: ${config.telegram.sessionPath}`);

      if (fs.existsSync(config.telegram.sessionPath)) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          status: "authenticated",
          sessionPath: config.telegram.sessionPath,
          hint: "Session file exists. Delete it to re-authenticate.",
        }, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          status: "not_authenticated",
          sessionPath: config.telegram.sessionPath,
          hint: "Run the Python setup script to create session: cd ~/jarvis-voice && python3 setup_userbot.py",
        }, null, 2));
      }
    });

  // Logs command
  root
    .command("logs")
    .description("View recent call logs")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log file (tail -f)")
    .action(async (options: { lines: string; follow?: boolean }) => {
      const logsDir = config.logPath ?? path.join(config.telegram.sessionPath, "..", "logs");
      const logPath = path.join(logsDir, "calls.jsonl");

      if (!fs.existsSync(logPath)) {
        // eslint-disable-next-line no-console
        console.log("No logs found yet.");
        return;
      }

      if (options.follow) {
        const { spawn } = await import("node:child_process");
        spawn("tail", ["-f", "-n", options.lines, logPath], { stdio: "inherit" });
      } else {
        const { spawn } = await import("node:child_process");
        spawn("tail", ["-n", options.lines, logPath], { stdio: "inherit" });
      }
    });

  // Call command (for testing)
  root
    .command("call")
    .description("Initiate a test call (for development)")
    .requiredOption("-u, --user <id>", "Telegram user ID to call")
    .option("-m, --message <text>", "Initial message to speak")
    .action(async (options: { user: string; message?: string }) => {
      try {
        const rt = await ensureRuntime();
        const userId = parseInt(options.user, 10);

        if (isNaN(userId)) {
          throw new Error("Invalid user ID");
        }

        logger.info(`Initiating call to user ${userId}...`);
        const result = await rt.initiateCall(userId);

        if (!result.success) {
          throw new Error(result.error || "Failed to initiate call");
        }

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          success: true,
          callId: result.callId,
        }, null, 2));

        // If message provided, speak it after connection
        if (options.message && result.callId) {
          logger.info(`Speaking: "${options.message}"`);
          // This would be implemented in the runtime
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  // End call command
  root
    .command("end")
    .description("End the current call")
    .option("--call-id <id>", "Call ID to end (uses current if not specified)")
    .action(async (options: { callId?: string }) => {
      try {
        const rt = await ensureRuntime();
        const currentCall = rt.getCurrentCall();

        const callId = options.callId || currentCall?.callId;
        if (!callId) {
          throw new Error("No active call");
        }

        logger.info(`Ending call ${callId}...`);
        const result = await rt.endCall(callId);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          success: result.success,
          error: result.error,
        }, null, 2));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });
}
