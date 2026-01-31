/**
 * Voice Context Manager
 *
 * Tracks pending voice messages that need TTS responses
 * even when processed through normal Clawdbot queue
 */
// In-memory store for voice contexts (keyed by `${userId}:${messageId}`)
const pendingVoiceContexts = new Map();
// TTL for voice contexts (10 minutes)
const CONTEXT_TTL_MS = 10 * 60 * 1000;
/**
 * Store voice context for a message that needs TTS response later
 */
export function storeVoiceContext(ctx) {
    const key = `${ctx.userId}:${ctx.messageId}`;
    pendingVoiceContexts.set(key, ctx);
    // Cleanup old entries
    cleanupExpiredContexts();
}
/**
 * Check if a user has pending voice context (wants TTS response)
 * Returns the context and removes it from the store
 */
export function consumeVoiceContext(userId) {
    // Find the most recent voice context for this user
    let latestContext = null;
    let latestKey = null;
    for (const [key, ctx] of pendingVoiceContexts.entries()) {
        if (ctx.userId === userId && ctx.wantsVoiceResponse) {
            if (!latestContext || ctx.timestamp > latestContext.timestamp) {
                latestContext = ctx;
                latestKey = key;
            }
        }
    }
    if (latestKey && latestContext) {
        pendingVoiceContexts.delete(latestKey);
        return latestContext;
    }
    return null;
}
/**
 * Check if user has any pending voice context without consuming it
 */
export function hasVoiceContext(userId) {
    for (const ctx of pendingVoiceContexts.values()) {
        if (ctx.userId === userId && ctx.wantsVoiceResponse) {
            return true;
        }
    }
    return false;
}
/**
 * Get voice context for a specific user (peek without consuming)
 */
export function peekVoiceContext(userId) {
    for (const ctx of pendingVoiceContexts.values()) {
        if (ctx.userId === userId && ctx.wantsVoiceResponse) {
            return ctx;
        }
    }
    return null;
}
/**
 * Remove expired contexts
 */
function cleanupExpiredContexts() {
    const now = Date.now();
    for (const [key, ctx] of pendingVoiceContexts.entries()) {
        if (now - ctx.timestamp > CONTEXT_TTL_MS) {
            pendingVoiceContexts.delete(key);
        }
    }
}
/**
 * Get count of pending voice contexts (for debugging)
 */
export function getPendingVoiceContextCount() {
    return pendingVoiceContexts.size;
}
//# sourceMappingURL=voice-context.js.map