import type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentImageContent,
  AgentMessage,
  AgentState,
  ModelInfo,
  ModelInputKind,
  PromptOptions,
  RpcLogEntry,
  RpcLogListener,
  ThinkingLevel,
} from './backend.js';
import type { RuntimeProxyConnection } from './proxy-process.js';

export interface ProxyBackendOptions extends RuntimeProxyConnection {
  chatId: string;
  projectId: string;
  cwd: string;
  title?: string;
}

function isModelInputKind(value: unknown): value is ModelInputKind {
  return value === 'text' || value === 'image';
}

function normalizeModels(raw: unknown): ModelInfo[] {
  const models = Array.isArray(raw) ? raw : [];
  const out: ModelInfo[] = [];
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const o = model as Record<string, unknown>;
    const provider = typeof o.provider === 'string' ? o.provider : null;
    const id = typeof o.id === 'string' ? o.id : null;
    if (!provider || !id) continue;
    out.push({
      provider,
      id,
      name: typeof o.name === 'string' ? o.name : id,
      reasoning: o.reasoning === true,
      input: Array.isArray(o.input) ? o.input.filter(isModelInputKind) : ['text'],
      contextWindow: typeof o.contextWindow === 'number' ? o.contextWindow : 0,
    });
  }
  return out;
}

function promptPayload(text: string, options?: PromptOptions): Record<string, unknown> {
  return {
    message: text,
    ...(options?.images?.length ? { images: options.images } : {}),
    ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
  };
}

function stripImageMetadata(images: AgentImageContent[] = []): AgentImageContent[] {
  return images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}

/** AgentBackend backed by the Rust runtime proxy over HTTP + SSE. */
export class ProxyBackend implements AgentBackend {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly rpcLogListeners = new Set<RpcLogListener>();
  private openPromise: Promise<void> | null = null;
  private eventsAbort: AbortController | null = null;
  private sessionFile: string | null = null;
  private disposed = false;

  constructor(private readonly options: ProxyBackendOptions) {
    this.connectEvents();
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeRpcLogs(listener: RpcLogListener): () => void {
    this.rpcLogListeners.add(listener);
    return () => {
      this.rpcLogListeners.delete(listener);
    };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures are isolated from the transport.
      }
    }
  }

  private emitRpcLog(entry: RpcLogEntry): void {
    for (const listener of this.rpcLogListeners) {
      try {
        listener(entry);
      } catch {
        // Listener failures are isolated from the transport.
      }
    }
  }

  private url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }

  private authHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    return headers;
  }

  private async ensureOpened(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = (async () => {
      const response = await fetch(this.url(`/api/chats/${encodeURIComponent(this.options.chatId)}/open`), {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          projectId: this.options.projectId,
          cwd: this.options.cwd,
          title: this.options.title,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
    })();
    return this.openPromise;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.ensureOpened();
    const headers = this.authHeaders(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(this.url(path), { ...init, headers });
    if (!response.ok) throw new Error(await response.text());
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text.trim()) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private connectEvents(): void {
    if (this.eventsAbort || this.disposed) return;
    const abort = new AbortController();
    this.eventsAbort = abort;
    const endpoint = new URL('/api/events/sse', this.options.baseUrl);
    if (this.options.token) endpoint.searchParams.set('token', this.options.token);

    void (async () => {
      while (!this.disposed && !abort.signal.aborted) {
        try {
          const response = await fetch(endpoint, { signal: abort.signal });
          if (!response.ok || !response.body) throw new Error(`proxy event stream failed: ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split = buffer.indexOf('\n\n');
            while (split >= 0) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              this.handleSseFrame(frame);
              split = buffer.indexOf('\n\n');
            }
          }
        } catch (err) {
          if (abort.signal.aborted || this.disposed) return;
          this.emit({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        }
      }
    })();
  }

  private handleSseFrame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    this.handleProxyEvent(payload);
  }

  private handleProxyEvent(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const o = payload as Record<string, unknown>;
    if (typeof o.chatId === 'string' && o.chatId === this.options.chatId && o.event) {
      this.emit(o.event as AgentEvent);
      return;
    }
    if (o.type === 'rpc_log' && o.entry) {
      this.emitRpcLog(o.entry as RpcLogEntry);
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    await this.post<void>(
      `/api/chats/${encodeURIComponent(this.options.chatId)}/prompt`,
      promptPayload(text, options ? { ...options, images: stripImageMetadata(options.images) } : undefined),
    );
  }

  async steer(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/steer`, {
      message: text,
      ...(images?.length ? { images: stripImageMetadata(images) } : {}),
    });
  }

  async followUp(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/follow-up`, {
      message: text,
      ...(images?.length ? { images: stripImageMetadata(images) } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/abort`);
  }

  async getState(): Promise<AgentState> {
    const state = await this.request<AgentState & { sessionFile?: string | null }>(
      `/api/chats/${encodeURIComponent(this.options.chatId)}/state`,
    );
    if (typeof state.sessionFile === 'string') this.sessionFile = state.sessionFile;
    return state;
  }

  async getMessages(): Promise<AgentMessage[]> {
    return this.request<AgentMessage[]>(`/api/chats/${encodeURIComponent(this.options.chatId)}/messages`);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    try {
      return normalizeModels(
        await this.request<unknown>(`/api/chats/${encodeURIComponent(this.options.chatId)}/models`),
      );
    } catch {
      return [];
    }
  }

  async getSessionFile(): Promise<string | null> {
    await this.getState().catch(() => undefined);
    return this.sessionFile;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/model`, {
      provider,
      modelId,
    });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/thinking-level`, {
      level,
    });
  }

  async newSession(): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/new-session`);
    this.sessionFile = null;
  }

  async switchSession(path: string): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/switch-session`, { path });
    this.sessionFile = path;
  }

  async fork(entryId: string): Promise<void> {
    await this.post<void>(`/api/chats/${encodeURIComponent(this.options.chatId)}/fork`, { entryId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.eventsAbort?.abort();
    this.eventsAbort = null;
    if (!this.openPromise) return;
    await fetch(this.url(`/api/chats/${encodeURIComponent(this.options.chatId)}`), {
      method: 'DELETE',
      headers: this.authHeaders(),
    }).catch(() => undefined);
  }
}
