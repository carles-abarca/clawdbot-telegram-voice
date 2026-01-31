/**
 * Runtime holder for telegram-userbot plugin
 */
let runtime = null;
export function setTelegramUserbotRuntime(next) {
    runtime = next;
}
export function getTelegramUserbotRuntime() {
    if (!runtime) {
        throw new Error("Telegram Userbot runtime not initialized");
    }
    return runtime;
}
//# sourceMappingURL=runtime.js.map