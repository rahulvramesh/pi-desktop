/**
 * IPC contract shared between main, preload and renderer.
 *
 * The renderer imports only this file and `@agent/backend` for types — never
 * an implementation, never anything from `main/` or `preload/`. Channel names
 * are duplicated as string-literal types so both sides typecheck against the
 * same source.
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  PromptOptions,
  ThinkingLevel,
} from '../agent/backend.js';

export const IPC = {
  Prompt: 'agent:prompt',
  Steer: 'agent:steer',
  FollowUp: 'agent:followUp',
  Abort: 'agent:abort',
  GetState: 'agent:getState',
  GetMessages: 'agent:getMessages',
  SetModel: 'agent:setModel',
  SetThinkingLevel: 'agent:setThinkingLevel',
  NewSession: 'agent:newSession',
  SwitchSession: 'agent:switchSession',
  Fork: 'agent:fork',
  Event: 'agent:event',

  PrefsGet: 'prefs:get',
  PrefsSet: 'prefs:set',

  Meta: 'meta:get',
} as const;

export interface AppMeta {
  backend: 'mock' | 'sdk-local' | 'rpc-local' | 'rpc-ssh';
  version: string;
  platform: NodeJS.Platform;
}

export interface PrefsShape {
  theme: 'light' | 'dark';
  accent: string;
  density: 'compact' | 'regular' | 'comfy';
  sidebarVisible: boolean;
  rightPane: 'diff' | 'term' | 'preview' | 'none';
  /** Persisted only as a developer-facing debug tweak. */
  agentStateOverride: 'idle' | 'thinking' | 'working' | 'auto';
}

export const PREFS_DEFAULTS: PrefsShape = {
  theme: 'light',
  accent: '#c84a1f',
  density: 'regular',
  sidebarVisible: true,
  rightPane: 'diff',
  agentStateOverride: 'auto',
};

/**
 * Verbs that cross from the renderer into the main process. Each ends up as
 * an `ipcRenderer.invoke` on a typed channel, and is exposed on
 * `window.pi.<verb>` by the preload script.
 */
export interface PiApi {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  newSession(): Promise<void>;
  switchSession(path: string): Promise<void>;
  fork(entryId: string): Promise<void>;

  /** Subscribe to streamed AgentEvents. Returns an unsubscribe callback. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  prefs: {
    get(): Promise<PrefsShape>;
    set(patch: Partial<PrefsShape>): Promise<PrefsShape>;
  };

  /** Diagnostic info surfaced in the renderer footer. */
  meta(): Promise<AppMeta>;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    pi: PiApi;
  }
}

/**
 * Bridge events from main → renderer. The renderer subscribes via
 * window.pi.subscribe; this is the wire-level union that crosses IPC.
 *
 * `text_delta` events are batched by the main process into a single
 * `text_delta_batch` event before sending — keeps IPC traffic predictable
 * regardless of token rate. The renderer treats both as additive deltas on
 * the message buffer.
 */
export type WireEvent =
  | AgentEvent
  | { type: 'text_delta_batch'; messageId: string; delta: string };
