/**
 * Clawdbot Telegram Userbot Plugin
 *
 * Text and voice conversations via Telegram userbot
 * 100% local STT/TTS stack (Whisper + Piper)
 */
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
declare const plugin: {
    id: string;
    name: string;
    description: string;
    configSchema: any;
    register(api: ClawdbotPluginApi): void;
};
export default plugin;
//# sourceMappingURL=index.d.ts.map