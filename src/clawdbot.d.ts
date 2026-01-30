/**
 * Type declarations for clawdbot/plugin-sdk
 */

declare module "clawdbot/plugin-sdk" {
  export interface PluginRuntime {
    config: {
      loadConfig: () => any;
      writeConfigFile: (cfg: any) => Promise<void>;
    };
    logging: {
      getChildLogger: (opts: { module: string }) => Logger;
      shouldLogVerbose: () => boolean;
    };
    channel: {
      routing: {
        resolveAgentRoute: (opts: {
          cfg: any;
          channel: string;
          accountId?: string;
          peer: { kind: "dm" | "group" | "channel"; id: string };
        }) => {
          agentId: string;
          sessionKey: string;
          mainSessionKey: string;
          accountId: string;
        };
      };
      session: {
        resolveStorePath: (store: any, opts: { agentId: string }) => string;
        readSessionUpdatedAt: (opts: { storePath: string; sessionKey: string }) => number | undefined;
      };
      reply: {
        resolveEnvelopeFormatOptions: (cfg: any) => any;
        formatAgentEnvelope: (opts: {
          channel: string;
          from?: string;
          timestamp?: number;
          previousTimestamp?: number;
          envelope?: any;
          body: string;
        }) => string;
        dispatchReplyWithBufferedBlockDispatcher: (opts: {
          ctx: any;
          cfg: any;
          dispatcherOptions: {
            deliver: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; replyToId?: string }) => Promise<void>;
            onReplyStart?: () => void;
            onIdle?: () => void;
          };
        }) => Promise<void>;
      };
      mentions: {
        buildMentionRegexes: (cfg: any, agentId?: string) => RegExp[];
        matchesMentionPatterns: (text: string, regexes: RegExp[]) => boolean;
      };
      groups: {
        resolveRequireMention: (opts: {
          cfg: any;
          channel: string;
          groupId: string;
          accountId?: string;
        }) => boolean;
      };
      text: {
        hasControlCommand: (text: string, cfg: any) => boolean;
        chunkMarkdownText: (text: string, limit: number) => string[];
        resolveMarkdownTableMode: (opts: { cfg: any; channel: string; accountId?: string }) => string;
        convertMarkdownTables: (text: string, mode: string) => string;
      };
      media: {
        saveMediaBuffer: (
          buffer: Buffer,
          contentType: string,
          direction: string,
          maxBytes: number
        ) => Promise<{ path: string; contentType?: string }>;
      };
      reactions: {
        shouldAckReaction: (opts: any) => boolean;
      };
    };
    system: {
      enqueueSystemEvent: (text: string, meta: { sessionKey?: string; contextKey?: string }) => void;
    };
  }

  export interface Logger {
    info: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
    warn: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
    error: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
    debug: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
  }

  export interface ClawdbotPluginApi {
    runtime: PluginRuntime;
    logger: Logger;
    registerChannel: (opts: { plugin: ChannelPlugin<any> }) => void;
  }

  export interface ChannelPlugin<T> {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[] };
    configSchema?: any;
    config: ChannelConfigAdapter<T>;
    security?: ChannelSecurityAdapter<T>;
    messaging?: ChannelMessagingAdapter;
    outbound: ChannelOutboundAdapter;
    gateway?: ChannelGatewayAdapter<T>;
    status?: ChannelStatusAdapter<T>;
    onboarding?: any;
    pairing?: any;
    groups?: any;
    threading?: any;
    directory?: any;
    actions?: any;
    setup?: any;
  }

  export interface ChannelMeta {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    order?: number;
    aliases?: string[];
    quickstartAllowFrom?: boolean;
  }

  export interface ChannelCapabilities {
    chatTypes: readonly ("direct" | "group" | "channel" | "thread")[];
    voice?: boolean;
    voiceNotes?: boolean;
    reactions?: boolean;
    threads?: boolean;
    media?: boolean;
    nativeCommands?: boolean;
    blockStreaming?: boolean;
    polls?: boolean;
  }

  export interface ChannelConfigAdapter<T> {
    listAccountIds: (cfg: any) => string[];
    resolveAccount: (cfg: any, accountId?: string) => T;
    defaultAccountId?: (cfg: any) => string;
    setAccountEnabled?: (opts: { cfg: any; accountId: string; enabled: boolean }) => any;
    deleteAccount?: (opts: { cfg: any; accountId: string }) => any;
    isConfigured?: (account: T) => boolean;
    describeAccount?: (account: T) => {
      accountId: string;
      name?: string;
      enabled: boolean;
      configured: boolean;
      [key: string]: any;
    };
    resolveAllowFrom?: (opts: { cfg?: any; accountId?: string; account: T }) => string[];
    formatAllowFrom?: (opts: { allowFrom: string[] }) => string[];
  }

  export interface ChannelSecurityAdapter<T> {
    resolveDmPolicy?: (opts: { cfg?: any; accountId?: string; account: T }) => {
      policy: "open" | "pairing" | "allowlist" | "disabled";
      allowFrom: string[];
      policyPath?: string;
      allowFromPath?: string;
      approveHint?: string;
      normalizeEntry?: (raw: string) => string;
    };
    collectWarnings?: (opts: { account: T; cfg: any }) => string[];
  }

  export interface ChannelMessagingAdapter {
    normalizeTarget?: (raw: string) => string | undefined;
    targetResolver?: {
      looksLikeId: (raw: string) => boolean;
      hint: string;
    };
  }

  export interface ChannelOutboundAdapter {
    deliveryMode: "direct" | "queued";
    textChunkLimit?: number;
    chunker?: (text: string, limit: number) => string[];
    chunkerMode?: "markdown" | "text";
    sendText: (opts: {
      to: string;
      text: string;
      accountId?: string;
      deps?: any;
      replyToId?: string;
      threadId?: string;
    }) => Promise<{ ok: boolean; error?: string; channel?: string; messageId?: string }>;
    sendMedia?: (opts: {
      to: string;
      text?: string;
      mediaUrl?: string;
      accountId?: string;
      deps?: any;
      replyToId?: string;
      threadId?: string;
    }) => Promise<{ ok: boolean; error?: string; channel?: string; messageId?: string }>;
  }

  export interface ChannelGatewayAdapter<T> {
    startAccount?: (ctx: {
      account: T;
      cfg: any;
      runtime: PluginRuntime;
      abortSignal: AbortSignal;
      log?: Logger;
    }) => Promise<void>;
    stop?: () => Promise<void>;
    logoutAccount?: (opts: { accountId: string; cfg: any }) => Promise<any>;
  }

  export interface ChannelStatusAdapter<T> {
    defaultRuntime?: any;
    collectStatusIssues?: (opts: any) => any[];
    buildChannelSummary?: (opts: any) => any;
    probeAccount?: (opts: any) => Promise<any>;
    auditAccount?: (opts: any) => Promise<any>;
    buildAccountSnapshot?: (opts: { account: T; cfg: any; runtime?: any; probe?: any; audit?: any }) => any;
  }

  export function emptyPluginConfigSchema(): any;
  export function buildChannelConfigSchema(schema: any): any;
  export function createTypingCallbacks(opts: {
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
    onStartError?: (err: unknown) => void;
    onStopError?: (err: unknown) => void;
  }): {
    onReplyStart: () => void;
    onIdle: () => void;
  };
  export function logInboundDrop(opts: {
    log: (message: string) => void;
    channel: string;
    reason: string;
    target: string;
  }): void;
  export function logTypingFailure(opts: {
    log: (message: string) => void;
    channel: string;
    action: "start" | "stop";
    target: string;
    error: unknown;
  }): void;
  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(accountId?: string): string;
}
