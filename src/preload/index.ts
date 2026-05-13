/**
 * Typed preload bridge.
 *
 * The renderer is fully sandboxed. The ONLY surface it sees is the verbs
 * defined here, exposed via contextBridge. No fs, no child_process, no path.
 * Channel names are imported from @shared/ipc so any change ripples to both
 * sides at compile time.
 *
 * Subscribe semantics: ipcRenderer.on returns no handle, so we install a
 * single multiplexed listener that fans out to per-subscription callbacks.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  PromptOptions,
  ThinkingLevel,
} from '../agent/backend.js';
import { IPC, type PiApi, type PrefsShape, type WireEvent } from '../shared/ipc.js';

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();

ipcRenderer.on(IPC.Event, (_e, payload: WireEvent) => {
  // text_delta_batch is wire-only; expand it to a synthetic text_delta for the
  // renderer so consumer code can stay agnostic of batching policy.
  if (payload.type === 'text_delta_batch') {
    const expanded: AgentEvent = {
      type: 'text_delta',
      messageId: payload.messageId,
      delta: payload.delta,
    };
    for (const l of Array.from(listeners)) l(expanded);
    return;
  }
  for (const l of Array.from(listeners)) l(payload);
});

const pi: PiApi = {
  prompt: (text: string, options?: PromptOptions) => ipcRenderer.invoke(IPC.Prompt, text, options),
  steer: (text: string) => ipcRenderer.invoke(IPC.Steer, text),
  followUp: (text: string) => ipcRenderer.invoke(IPC.FollowUp, text),
  abort: () => ipcRenderer.invoke(IPC.Abort),
  getState: (): Promise<AgentState> => ipcRenderer.invoke(IPC.GetState),
  getMessages: (): Promise<AgentMessage[]> => ipcRenderer.invoke(IPC.GetMessages),
  setModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke(IPC.SetModel, provider, modelId),
  setThinkingLevel: (level: ThinkingLevel) => ipcRenderer.invoke(IPC.SetThinkingLevel, level),
  newSession: () => ipcRenderer.invoke(IPC.NewSession),
  switchSession: (path: string) => ipcRenderer.invoke(IPC.SwitchSession, path),
  fork: (entryId: string) => ipcRenderer.invoke(IPC.Fork, entryId),
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  prefs: {
    get: (): Promise<PrefsShape> => ipcRenderer.invoke(IPC.PrefsGet),
    set: (patch: Partial<PrefsShape>): Promise<PrefsShape> => ipcRenderer.invoke(IPC.PrefsSet, patch),
  },
  meta: () => ipcRenderer.invoke(IPC.Meta),
};

contextBridge.exposeInMainWorld('pi', pi);
