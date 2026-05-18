import { HttpPiClient } from './http-pi-client.js';
import {
  PREFS_DEFAULTS,
  type AppMeta,
  type AppPlatform,
  type Chat,
  type ChatRuntimeStatus,
  type FsEntry,
  type NotificationTestResult,
  type PiApi,
  type PrefsShape,
  type Project,
} from '../../shared/ipc.js';
import type {
  AgentEvent,
  AgentImageContent,
  AgentMessage,
  AgentState,
  ModelInfo,
  PromptOptions,
  RpcLogEntry,
  ThinkingLevel,
} from '../../agent/backend.js';

/**
 * Renderer transport boundary. React/stores should talk to `piClient`, not
 * directly to Electron's `window.pi`. In Electron we delegate to preload; in a
 * plain browser we either connect to a Rust proxy from URL/localStorage config
 * or fall back to a no-op client so the dev page does not blank-crash.
 */
export type PiClient = PiApi;

const INITIAL_BROWSER_STATE: AgentState = {
  runState: 'idle',
  modelProvider: 'browser',
  modelId: 'not-connected',
  thinkingLevel: 'medium',
  tokensUsed: 0,
  tokensMax: 200_000,
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  contextPercent: 0,
  autoCompactionEnabled: true,
  sessionId: 'browser-not-connected',
};

function browserPlatform(): AppPlatform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  if (platform.includes('linux')) return 'linux';
  return 'linux';
}

function unavailable(message = 'Browser mode requires a Pi runtime proxy connection.'): Promise<never> {
  return Promise.reject(new Error(message));
}

function createBrowserFallbackClient(): PiClient {
  const prefs: PrefsShape = { ...PREFS_DEFAULTS, hasSeenWelcome: false };
  const meta: AppMeta = { backend: 'proxy', version: '0.1.0', platform: browserPlatform() };
  return {
    prompt: (_text: string, _options?: PromptOptions) => unavailable(),
    steer: (_text: string, _images?: AgentImageContent[]) => unavailable(),
    followUp: (_text: string, _images?: AgentImageContent[]) => unavailable(),
    abort: async () => {},
    getState: async () => INITIAL_BROWSER_STATE,
    getMessages: async (): Promise<AgentMessage[]> => [],
    getAvailableModels: async (): Promise<ModelInfo[]> => [],
    setModel: (_provider: string, _modelId: string) => unavailable(),
    setThinkingLevel: (_level: ThinkingLevel) => unavailable(),
    newSession: () => unavailable(),
    switchSession: (_path: string) => unavailable(),
    fork: (_entryId: string) => unavailable(),
    subscribe: (_listener: (event: AgentEvent) => void) => () => {},
    subscribeAll: () => () => {},
    runtimes: {
      list: async (): Promise<ChatRuntimeStatus[]> => [],
      subscribe: () => () => {},
    },
    rpcLogs: {
      list: async (): Promise<RpcLogEntry[]> => [],
      clear: async () => {},
      subscribe: () => () => {},
    },
    notifications: {
      test: async (): Promise<NotificationTestResult> => ({
        shouldNotify: false,
        sound: false,
        toast: false,
        attention: false,
        reason: 'browser fallback',
        notifiedAt: null,
        dryRun: true,
        toastSupported: false,
      }),
    },
    prefs: {
      get: async () => prefs,
      set: async (patch: Partial<PrefsShape>) => Object.assign(prefs, patch),
    },
    projects: {
      list: async (): Promise<Project[]> => [],
      pick: async () => null,
      add: (_path: string, _name?: string) => unavailable(),
      remove: async (_id: string) => {},
      icon: async (_path: string) => null,
    },
    chats: {
      list: async (_projectId: string): Promise<Chat[]> => [],
      create: (_projectId: string, _title?: string) => unavailable(),
      rename: async (_id: string, _title: string) => {},
      delete: async (_id: string) => {},
      open: (_id: string) => unavailable(),
    },
    fs: {
      tree: async (_rootPath: string): Promise<FsEntry[]> => [],
    },
    git: {
      status: async (_cwd: string) => ({ branch: null, modified: 0 }),
    },
    meta: async () => meta,
    window: {
      minimize: async () => {},
      maximizeToggle: async () => false,
      close: async () => {},
      onMaximizedChange: () => () => {},
    },
  };
}

function browserProxyClientFromLocation(): PiClient | null {
  const params = new URLSearchParams(window.location.search);
  const baseUrl =
    params.get('piProxyUrl') ||
    params.get('proxy') ||
    localStorage.getItem('piProxyUrl') ||
    localStorage.getItem('proxy');
  const token =
    params.get('piProxyToken') || params.get('token') || localStorage.getItem('piProxyToken') || '';
  if (!baseUrl) return null;
  localStorage.setItem('piProxyUrl', baseUrl);
  if (token) localStorage.setItem('piProxyToken', token);
  return new HttpPiClient({ baseUrl, token });
}

function initialClient(): PiClient {
  const maybeWindow = window as Window & { pi?: PiApi };
  if (maybeWindow.pi) return maybeWindow.pi;
  return browserProxyClientFromLocation() ?? createBrowserFallbackClient();
}

export const electronPiClient: PiClient | null = (window as Window & { pi?: PiApi }).pi ?? null;

let currentClient: PiClient = initialClient();

export function getPiClient(): PiClient {
  return currentClient;
}

export function setPiClient(client: PiClient): void {
  currentClient = client;
}

export const piClient: PiClient = new Proxy({} as PiClient, {
  get(_target, prop: keyof PiClient) {
    return getPiClient()[prop];
  },
});
