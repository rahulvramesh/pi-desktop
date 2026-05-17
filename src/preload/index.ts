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
  AgentImageContent,
  AgentMessage,
  AgentState,
  ModelInfo,
  PromptOptions,
  RpcLogEntry,
  ThinkingLevel,
} from '../agent/backend.js';
import {
  IPC,
  type Chat,
  type FsEntry,
  type PiApi,
  type PrefsShape,
  type Project,
  type WireEvent,
} from '../shared/ipc.js';

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();
type RpcLogListener = (entry: RpcLogEntry) => void;
const rpcLogListeners = new Set<RpcLogListener>();

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
  if (payload.type === 'thinking_delta_batch') {
    const expanded: AgentEvent = {
      type: 'thinking_delta',
      messageId: payload.messageId,
      delta: payload.delta,
    };
    for (const l of Array.from(listeners)) l(expanded);
    return;
  }
  for (const l of Array.from(listeners)) l(payload as AgentEvent);
});

type MaxListener = (isMaximized: boolean) => void;
const maxListeners = new Set<MaxListener>();
ipcRenderer.on(IPC.WinIsMaximizedChanged, (_e, isMaximized: boolean) => {
  for (const l of Array.from(maxListeners)) l(isMaximized);
});

ipcRenderer.on(IPC.RpcLogEvent, (_e, entry: RpcLogEntry) => {
  for (const l of Array.from(rpcLogListeners)) l(entry);
});

const pi: PiApi = {
  prompt: (text: string, options?: PromptOptions) => ipcRenderer.invoke(IPC.Prompt, text, options),
  steer: (text: string, images?: AgentImageContent[]) => ipcRenderer.invoke(IPC.Steer, text, images),
  followUp: (text: string, images?: AgentImageContent[]) =>
    ipcRenderer.invoke(IPC.FollowUp, text, images),
  abort: () => ipcRenderer.invoke(IPC.Abort),
  getState: (): Promise<AgentState> => ipcRenderer.invoke(IPC.GetState),
  getMessages: (): Promise<AgentMessage[]> => ipcRenderer.invoke(IPC.GetMessages),
  getAvailableModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.Models),
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
  rpcLogs: {
    list: (): Promise<RpcLogEntry[]> => ipcRenderer.invoke(IPC.RpcLogsGet),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.RpcLogsClear),
    subscribe: (listener: RpcLogListener) => {
      rpcLogListeners.add(listener);
      return () => {
        rpcLogListeners.delete(listener);
      };
    },
  },
  prefs: {
    get: (): Promise<PrefsShape> => ipcRenderer.invoke(IPC.PrefsGet),
    set: (patch: Partial<PrefsShape>): Promise<PrefsShape> => ipcRenderer.invoke(IPC.PrefsSet, patch),
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.ProjectsList),
    pick: (): Promise<{ path: string; name: string } | null> =>
      ipcRenderer.invoke(IPC.ProjectsPick),
    add: (path: string, name?: string): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsAdd, path, name),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ProjectsRemove, id),
    icon: (path: string): Promise<string | null> => ipcRenderer.invoke(IPC.ProjectIcon, path),
  },
  chats: {
    list: (projectId: string): Promise<Chat[]> => ipcRenderer.invoke(IPC.ChatsList, projectId),
    create: (projectId: string, title?: string): Promise<Chat> =>
      ipcRenderer.invoke(IPC.ChatsCreate, projectId, title),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ChatsRename, id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ChatsDelete, id),
    open: (id: string): Promise<Chat> => ipcRenderer.invoke(IPC.ChatOpen, id),
  },
  fs: {
    tree: (rootPath: string): Promise<FsEntry[]> => ipcRenderer.invoke(IPC.FsTree, rootPath),
  },
  git: {
    status: (
      cwd: string,
    ): Promise<{ branch: string | null; modified: number }> =>
      ipcRenderer.invoke(IPC.GitStatus, cwd),
  },
  meta: () => ipcRenderer.invoke(IPC.Meta),
  window: {
    minimize: () => ipcRenderer.invoke(IPC.WinMinimize),
    maximizeToggle: () => ipcRenderer.invoke(IPC.WinMaximizeToggle) as Promise<boolean>,
    close: () => ipcRenderer.invoke(IPC.WinClose),
    onMaximizedChange(listener: MaxListener) {
      maxListeners.add(listener);
      return () => {
        maxListeners.delete(listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('pi', pi);
