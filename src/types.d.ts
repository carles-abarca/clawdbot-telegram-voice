/**
 * Telegram Voice Plugin - Type Definitions
 */
export type CallState = "idle" | "initiating" | "ringing" | "active" | "speaking" | "listening" | "processing" | "ended" | "error";
export type CallDirection = "inbound" | "outbound";
export type EndReason = "completed" | "hangup-user" | "hangup-bot" | "timeout" | "error" | "rejected" | "busy";
export interface TranscriptEntry {
    timestamp: number;
    speaker: "bot" | "user";
    text: string;
}
export interface CallRecord {
    callId: string;
    peerId: number;
    peerName?: string;
    direction: CallDirection;
    state: CallState;
    startedAt: number;
    answeredAt?: number;
    endedAt?: number;
    endReason?: EndReason;
    transcript: TranscriptEntry[];
}
export interface CallEvent {
    type: string;
    callId: string;
    timestamp: number;
}
export interface CallInitiatedEvent extends CallEvent {
    type: "call.initiated";
    peerId: number;
    direction: CallDirection;
}
export interface CallAnsweredEvent extends CallEvent {
    type: "call.answered";
}
export interface CallEndedEvent extends CallEvent {
    type: "call.ended";
    reason: EndReason;
}
export interface SpeechEvent extends CallEvent {
    type: "call.speech";
    transcript: string;
    isFinal: boolean;
}
export interface SpeakingEvent extends CallEvent {
    type: "call.speaking";
    text: string;
}
export type NormalizedEvent = CallInitiatedEvent | CallAnsweredEvent | CallEndedEvent | SpeechEvent | SpeakingEvent;
export interface BridgeRequest {
    id: string;
    action: "start" | "join" | "leave" | "send_audio" | "status" | "auth";
    payload?: Record<string, unknown>;
}
export interface BridgeResponse {
    id: string;
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
}
export interface BridgeEvent {
    event: string;
    data: Record<string, unknown>;
}
export interface STTResult {
    text: string;
    language?: string;
    confidence?: number;
    duration?: number;
}
export interface TTSResult {
    audioPath: string;
    duration?: number;
}
export interface TelegramVoiceRuntime {
    config: import("./config.js").TelegramVoiceConfig;
    bridge: import("./telegram-bridge.js").TelegramBridge;
    stt: import("./stt.js").WhisperSTT;
    tts: import("./tts.js").PiperTTS;
    start(): Promise<void>;
    stop(): Promise<void>;
    getCurrentCall(): CallRecord | null;
    initiateCall(peerId: number): Promise<{
        success: boolean;
        callId?: string;
        error?: string;
    }>;
    endCall(callId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
}
export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
//# sourceMappingURL=types.d.ts.map