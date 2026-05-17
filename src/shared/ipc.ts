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
  AgentImageContent,
  AgentMessage,
  AgentState,
  ModelInfo,
  PromptOptions,
  RpcLogEntry,
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
  Models: 'agent:models',
  NewSession: 'agent:newSession',
  SwitchSession: 'agent:switchSession',
  Fork: 'agent:fork',
  Event: 'agent:event',

  RpcLogEvent: 'dev:rpc-log',
  RpcLogsGet: 'dev:rpc-logs:get',
  RpcLogsClear: 'dev:rpc-logs:clear',

  PrefsGet: 'prefs:get',
  PrefsSet: 'prefs:set',

  ProjectsList: 'projects:list',
  ProjectsPick: 'projects:pick',
  ProjectsAdd: 'projects:add',
  ProjectsRemove: 'projects:remove',

  ChatsList: 'chats:list',
  ChatsCreate: 'chats:create',
  ChatsRename: 'chats:rename',
  ChatsDelete: 'chats:delete',
  ChatOpen: 'chat:open',

  FsTree: 'fs:tree',
  GitStatus: 'git:status',
  ProjectIcon: 'project:icon',

  Meta: 'meta:get',

  WinMinimize: 'win:minimize',
  WinMaximizeToggle: 'win:maximize-toggle',
  WinClose: 'win:close',
  WinIsMaximizedChanged: 'win:is-maximized-changed',
} as const;

/**
 * Process platform identifiers. Mirrors Node's `NodeJS.Platform` but kept
 * inline because @shared is imported from the renderer (no Node types there).
 */
export type AppPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export interface AppMeta {
  backend: 'mock' | 'sdk-local' | 'rpc-local' | 'rpc-ssh';
  version: string;
  platform: AppPlatform;
}

export interface PrefsShape {
  theme: 'light' | 'dark';
  accent: string;
  density: 'compact' | 'regular' | 'comfy';
  sidebarVisible: boolean;
  rightPane: 'files' | 'diff' | 'term' | 'preview' | 'rpc' | 'none';
  /** Enables developer-only affordances such as the RPC trace inspector. */
  devMode: boolean;
  /** Persisted only as a developer-facing debug tweak. */
  agentStateOverride: 'idle' | 'thinking' | 'working' | 'auto';
  /** Flipped true the first time the user leaves the Welcome screen. */
  hasSeenWelcome: boolean;
  /** Master switch for native completion notifications. */
  turnEndNotifyEnabled: boolean;
  /** Play the OS alert sound when Pi finishes a run. */
  turnEndNotifySound: boolean;
  /** Show a native OS notification when Pi finishes a run. */
  turnEndNotifyToast: boolean;
  /** Request dock/taskbar attention when Pi finishes a run. */
  turnEndNotifyAttention: boolean;
  /** Stay quiet when the completed chat is already focused and visible. */
  turnEndNotifyOnlyWhenUnfocused: boolean;
}

export const PREFS_DEFAULTS: PrefsShape = {
  theme: 'light',
  accent: '#c84a1f',
  density: 'regular',
  sidebarVisible: true,
  rightPane: 'files',
  devMode: false,
  agentStateOverride: 'auto',
  hasSeenWelcome: false,
  turnEndNotifyEnabled: true,
  turnEndNotifySound: true,
  turnEndNotifyToast: true,
  turnEndNotifyAttention: true,
  turnEndNotifyOnlyWhenUnfocused: true,
};

/**
 * A workspace folder the user added. `path` is an absolute filesystem path;
 * the pi agent is spawned with this as its cwd so it operates on these files.
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number | null;
}

/**
 * A conversation within a project. `sessionFile` is the pi JSONL session file
 * (owned by the agent, captured from get_state after the first prompt); null
 * until the chat has run at least once. Reopening a chat resumes that file.
 */
export interface Chat {
  id: string;
  projectId: string;
  title: string;
  sessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A node in the on-disk project file tree (Files pane). */
export interface FsEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  children?: FsEntry[];
}

/**
 * Verbs that cross from the renderer into the main process. Each ends up as
 * an `ipcRenderer.invoke` on a typed channel, and is exposed on
 * `window.pi.<verb>` by the preload script.
 */
export interface PiApi {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string, images?: AgentImageContent[]): Promise<void>;
  followUp(text: string, images?: AgentImageContent[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;
  getAvailableModels(): Promise<ModelInfo[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  newSession(): Promise<void>;
  switchSession(path: string): Promise<void>;
  fork(entryId: string): Promise<void>;

  /** Subscribe to streamed AgentEvents. Returns an unsubscribe callback. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /** Developer-mode trace of JSONL RPC traffic from `pi --mode rpc`. */
  rpcLogs: {
    list(): Promise<RpcLogEntry[]>;
    clear(): Promise<void>;
    subscribe(listener: (entry: RpcLogEntry) => void): () => void;
  };

  prefs: {
    get(): Promise<PrefsShape>;
    set(patch: Partial<PrefsShape>): Promise<PrefsShape>;
  };

  /** Project (workspace folder) management, persisted in SQLite. */
  projects: {
    list(): Promise<Project[]>;
    /** Open the OS folder picker. Returns null if the user cancelled. */
    pick(): Promise<{ path: string; name: string } | null>;
    /** Register a folder as a project (idempotent on path). */
    add(path: string, name?: string): Promise<Project>;
    remove(id: string): Promise<void>;
    /** A favicon-ish image for the project as a data URL, or null if none. */
    icon(path: string): Promise<string | null>;
  };

  /** Chats (agent sessions) within a project, persisted in SQLite. */
  chats: {
    list(projectId: string): Promise<Chat[]>;
    create(projectId: string, title?: string): Promise<Chat>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    /**
     * Make this chat active: (re)spawns the pi RPC agent in the project's
     * folder and resumes the chat's session file if it has one. Emits the
     * usual agent events; the renderer should reload messages after.
     */
    open(id: string): Promise<Chat>;
  };

  /** Read the project's on-disk file tree for the Files pane. */
  fs: {
    tree(rootPath: string): Promise<FsEntry[]>;
  };

  /** Git working-tree summary for the active project's folder. */
  git: {
    status(cwd: string): Promise<{ branch: string | null; modified: number }>;
  };

  /** Diagnostic info surfaced in the renderer footer. */
  meta(): Promise<AppMeta>;

  /** Window controls. Renderer uses these because the OS frame is hidden. */
  window: {
    minimize(): Promise<void>;
    maximizeToggle(): Promise<boolean>;
    close(): Promise<void>;
    onMaximizedChange(listener: (isMaximized: boolean) => void): () => void;
  };
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
  | { type: 'text_delta_batch'; messageId: string; delta: string }
  | { type: 'thinking_delta_batch'; messageId: string; delta: string };
