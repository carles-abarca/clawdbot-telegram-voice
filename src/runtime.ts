/**
 * Runtime holder for telegram-userbot plugin
 */

import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTelegramUserbotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTelegramUserbotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telegram Userbot runtime not initialized");
  }
  return runtime;
}
