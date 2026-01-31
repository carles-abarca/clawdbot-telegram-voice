/**
 * Voice Service Client - JSON-RPC client for telegram-voice-service
 */
export interface TranscribeResult {
    text?: string;
    language?: string;
    audio_path?: string;
    error?: string;
    details?: string;
}
export interface SynthesizeResult {
    audio_path?: string;
    language?: string;
    text?: string;
    error?: string;
    details?: string;
}
export interface LanguageResult {
    user_id?: string;
    language?: string;
    language_name?: string;
    error?: string;
}
export interface StatusResult {
    service: string;
    version: string;
    transport: string;
    socket: string;
    whisper_available: boolean;
    piper_available: boolean;
    supported_languages: string[];
    default_language: string;
    active_users: number;
}
export interface HealthResult {
    status: string;
    timestamp: string;
}
export declare class VoiceClient {
    private socketPath;
    private tcpHost;
    private tcpPort;
    private transport;
    private requestId;
    private timeout;
    constructor(options?: {
        timeout?: number;
    });
    /**
     * Transcriu àudio a text
     */
    transcribe(audioPath: string, userId?: string): Promise<TranscribeResult>;
    /**
     * Sintetitza text a àudio
     */
    synthesize(text: string, userId?: string): Promise<SynthesizeResult>;
    /**
     * Estableix l'idioma per un usuari
     */
    setLanguage(userId: string, language: string): Promise<LanguageResult>;
    /**
     * Obté l'idioma actual d'un usuari
     */
    getLanguage(userId: string): Promise<LanguageResult>;
    /**
     * Obté l'estat del servei
     */
    getStatus(): Promise<StatusResult>;
    /**
     * Health check
     */
    health(): Promise<HealthResult>;
    /**
     * Comprova si el servei està disponible
     */
    isAvailable(timeoutMs?: number): Promise<boolean>;
    /**
     * Fa una crida JSON-RPC al servei
     */
    private call;
    /**
     * Envia una request al servei via socket
     */
    private sendRequest;
}
export declare function getVoiceClient(): VoiceClient;
//# sourceMappingURL=voice-client.d.ts.map