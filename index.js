/**
 * Clawdbot Telegram Userbot Plugin
 *
 * Text and voice conversations via Telegram userbot
 * 100% local STT/TTS stack (Whisper + Piper)
 */
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import { telegramUserbotPlugin } from "./src/channel.js";
import { setTelegramUserbotRuntime } from "./src/runtime.js";
const plugin = {
    id: "telegram-userbot",
    name: "Telegram Userbot",
    description: "Text and voice conversations via Telegram userbot - 100% local STT/TTS",
    configSchema: emptyPluginConfigSchema(),
    register(api) {
        api.logger.info("[telegram-userbot] Registering channel plugin...");
        setTelegramUserbotRuntime(api.runtime);
        api.registerChannel({ plugin: telegramUserbotPlugin });
        api.logger.info("[telegram-userbot] Channel plugin registered!");
    },
};
export default plugin;
//# sourceMappingURL=index.js.map