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
import type {
  AgentEventEnvelope,
  AppMeta,
  Chat,
  ChatRuntimeStatus,
  FsEntry,
  NotificationTestResult,
  PiApi,
  PrefsShape,
  Project,
  WireEvent,
  WireEventEnvelope,
} from '../../shared/ipc.js';

export interface HttpPiClientOptions {
  baseUrl: string;
  /** Bearer token for fetch requests; sent as `?token=` on WebSocket because browsers cannot set WS headers. */
  token?: string;
  wsUrl?: string;
}

type Listener<T> = (value: T) => void;

function expandWireEvent(payload: WireEvent): AgentEvent {
  if (payload.type === 'text_delta_batch') {
    return { type: 'text_delta', messageId: payload.messageId, delta: payload.delta };
  }
  if (payload.type === 'thinking_delta_batch') {
    return { type: 'thinking_delta', messageId: payload.messageId, delta: payload.delta };
  }
  return payload as AgentEvent;
}

function withQuery(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

function looksLikeEnvelope(value: unknown): value is WireEventEnvelope {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.chatId === 'string' && typeof o.projectId === 'string' && !!o.event;
}

/**
 * Browser/web transport for the future Rust runtime proxy.
 *
 * Electron currently uses `electronPiClient`; this class lets the React app use
 * the same `PiClient` contract over HTTP/WebSocket when browser mode lands.
 */
export class HttpPiClient implements PiApi {
  private activeChatId: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private readonly eventListeners = new Set<Listener<AgentEventEnvelope>>();
  private readonly runtimeStatusListeners = new Set<Listener<ChatRuntimeStatus>>();
  private readonly rpcLogListeners = new Set<Listener<RpcLogEntry>>();
  private readonly maxListeners = new Set<Listener<boolean>>();

  constructor(private readonly options: HttpPiClientOptions) {}

  private url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    const response = await fetch(this.url(path), { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Pi proxy request failed: ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text.trim()) return undefined as T;
    return JSON.parse(text) as T;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  private requireActiveChat(): string {
    if (!this.activeChatId) throw new Error('No active chat. Open or create a chat first.');
    return this.activeChatId;
  }

  private wsEndpoint(): string {
    const raw = this.options.wsUrl ?? new URL('/api/events', this.options.baseUrl).toString();
    const url = new URL(raw.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'));
    if (this.options.token) url.searchParams.set('token', this.options.token);
    return url.toString();
  }

  private connectEvents(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.ws = new WebSocket(this.wsEndpoint());
    this.ws.onmessage = (message) => this.handleWsMessage(message.data);
    this.ws.onclose = () => {
      this.ws = null;
      if (this.eventListeners.size + this.runtimeStatusListeners.size + this.rpcLogListeners.size === 0) {
        return;
      }
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connectEvents();
      }, 1_000);
    };
  }

  private handleWsMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      return;
    }

    const payload = parsed as Record<string, unknown>;
    if (looksLikeEnvelope(payload)) {
      const envelope: AgentEventEnvelope = { ...payload, event: expandWireEvent(payload.event) };
      for (const listener of Array.from(this.eventListeners)) listener(envelope);
      return;
    }

    if (payload.type === 'runtime_status' && payload.status) {
      for (const listener of Array.from(this.runtimeStatusListeners)) {
        listener(payload.status as ChatRuntimeStatus);
      }
      return;
    }

    if (payload.type === 'rpc_log' && payload.entry) {
      for (const listener of Array.from(this.rpcLogListeners)) listener(payload.entry as RpcLogEntry);
    }
  }

  private promptPayload(text: string, options?: PromptOptions): Record<string, unknown> {
    return {
      message: text,
      ...(options?.images?.length ? { images: options.images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    };
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/prompt`, this.promptPayload(text, options));
  }

  steer(text: string, images?: AgentImageContent[]): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/steer`, {
      message: text,
      ...(images?.length ? { images } : {}),
    });
  }

  followUp(text: string, images?: AgentImageContent[]): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/follow-up`, {
      message: text,
      ...(images?.length ? { images } : {}),
    });
  }

  abort(): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/abort`);
  }

  getState(): Promise<AgentState> {
    return this.request<AgentState>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/state`);
  }

  getMessages(): Promise<AgentMessage[]> {
    return this.request<AgentMessage[]>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/messages`);
  }

  getAvailableModels(): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/models`);
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/model`, {
      provider,
      modelId,
    });
  }

  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/thinking-level`, { level });
  }

  newSession(): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/new-session`);
  }

  switchSession(path: string): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/switch-session`, { path });
  }

  fork(entryId: string): Promise<void> {
    return this.post<void>(`/api/chats/${encodeURIComponent(this.requireActiveChat())}/fork`, { entryId });
  }

  subscribe(listener: Listener<AgentEvent>): () => void {
    return this.subscribeAll((envelope) => {
      if (envelope.chatId === this.activeChatId) listener(envelope.event);
    });
  }

  subscribeAll(listener: Listener<AgentEventEnvelope>): () => void {
    this.eventListeners.add(listener);
    this.connectEvents();
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  runtimes = {
    list: (): Promise<ChatRuntimeStatus[]> => this.request<ChatRuntimeStatus[]>('/api/runtimes'),
    subscribe: (listener: Listener<ChatRuntimeStatus>): (() => void) => {
      this.runtimeStatusListeners.add(listener);
      this.connectEvents();
      return () => {
        this.runtimeStatusListeners.delete(listener);
      };
    },
  };

  rpcLogs = {
    list: (): Promise<RpcLogEntry[]> => this.request<RpcLogEntry[]>('/api/dev/rpc-logs'),
    clear: (): Promise<void> => this.delete<void>('/api/dev/rpc-logs'),
    subscribe: (listener: Listener<RpcLogEntry>): (() => void) => {
      this.rpcLogListeners.add(listener);
      this.connectEvents();
      return () => {
        this.rpcLogListeners.delete(listener);
      };
    },
  };

  notifications = {
    test: (): Promise<NotificationTestResult> =>
      this.post<NotificationTestResult>('/api/notifications/test'),
  };

  prefs = {
    get: (): Promise<PrefsShape> => this.request<PrefsShape>('/api/prefs'),
    set: (patch: Partial<PrefsShape>): Promise<PrefsShape> =>
      this.patch<PrefsShape>('/api/prefs', patch),
  };

  projects = {
    list: (): Promise<Project[]> => this.request<Project[]>('/api/projects'),
    pick: (): Promise<{ path: string; name: string } | null> =>
      this.post<{ path: string; name: string } | null>('/api/projects/pick'),
    add: (path: string, name?: string): Promise<Project> =>
      this.post<Project>('/api/projects', { path, name }),
    remove: (id: string): Promise<void> =>
      this.delete<void>(`/api/projects/${encodeURIComponent(id)}`),
    icon: (path: string): Promise<string | null> =>
      this.request<string | null>(withQuery('/api/projects/icon', { path })),
  };

  chats = {
    list: (projectId: string): Promise<Chat[]> =>
      this.request<Chat[]>(`/api/projects/${encodeURIComponent(projectId)}/chats`),
    create: (projectId: string, title?: string): Promise<Chat> =>
      this.post<Chat>(`/api/projects/${encodeURIComponent(projectId)}/chats`, { title }),
    rename: (id: string, title: string): Promise<void> =>
      this.patch<void>(`/api/chats/${encodeURIComponent(id)}`, { title }),
    delete: (id: string): Promise<void> => this.delete<void>(`/api/chats/${encodeURIComponent(id)}`),
    open: async (id: string): Promise<Chat> => {
      const chat = await this.post<Chat>(`/api/chats/${encodeURIComponent(id)}/open`);
      this.activeChatId = chat.id;
      return chat;
    },
  };

  fs = {
    tree: (rootPath: string): Promise<FsEntry[]> =>
      this.request<FsEntry[]>(withQuery('/api/fs/tree', { rootPath })),
  };

  git = {
    status: (cwd: string): Promise<{ branch: string | null; modified: number }> =>
      this.request<{ branch: string | null; modified: number }>(withQuery('/api/git/status', { cwd })),
  };

  meta(): Promise<AppMeta> {
    return this.request<AppMeta>('/api/meta');
  }

  window = {
    minimize: async (): Promise<void> => {},
    maximizeToggle: async (): Promise<boolean> => false,
    close: async (): Promise<void> => {},
    onMaximizedChange: (listener: Listener<boolean>): (() => void) => {
      this.maxListeners.add(listener);
      return () => {
        this.maxListeners.delete(listener);
      };
    },
  };
}
