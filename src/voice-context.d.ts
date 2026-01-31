/**
 * Voice Context Manager
 *
 * Tracks pending voice messages that need TTS responses
 * even when processed through normal Clawdbot queue
 */
interface VoiceContext {
    userId: string;
    messageId: string;
    language: string;
    timestamp: number;
    wantsVoiceResponse: boolean;
}
/**
 * Store voice context for a message that needs TTS response later
 */
export declare function storeVoiceContext(ctx: VoiceContext): void;
/**
 * Check if a user has pending voice context (wants TTS response)
 * Returns the context and removes it from the store
 */
export declare function consumeVoiceContext(userId: string): VoiceContext | null;
/**
 * Check if user has any pending voice context without consuming it
 */
export declare function hasVoiceContext(userId: string): boolean;
/**
 * Get voice context for a specific user (peek without consuming)
 */
export declare function peekVoiceContext(userId: string): VoiceContext | null;
/**
 * Get count of pending voice contexts (for debugging)
 */
export declare function getPendingVoiceContextCount(): number;
export {};
//# sourceMappingURL=voice-context.d.ts.map