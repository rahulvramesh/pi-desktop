/**
 * LocalSdkBackend — wraps Pi's @earendil-works/pi-coding-agent in-process.
 *
 * Hardcoded to Anthropic Claude Sonnet for P3. ANTHROPIC_API_KEY is read from
 * process.env *only*; never persisted, never logged, never put on URLs. If
 * the key is missing we still construct the backend (so the renderer can
 * show its UI) but the first prompt() emits an `error` event and the run
 * never starts.
 *
 * Streaming behavior: SDK emits `message_update` events whose inner
 * `assistantMessageEvent` carries text_delta chunks. We re-shape those into
 * our flat AgentEvent union and forward to subscribers. The main process is
 * responsible for batching text_delta events in ~16ms windows before they
 * cross IPC (see main/agent-bridge.ts).
 */

import { createAgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';

import type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentImageContent,
  AgentMessage,
  AgentRunState,
  AgentState,
  ModelInfo,
  ModelInputKind,
  PromptOptions,
  ThinkingLevel,
  TokenUsageSummary,
  ToolCallSummary,
} from './backend.js';

export interface LocalSdkBackendOptions {
  cwd: string;
  /** Default model id. Hardcoded to claude-sonnet-4-6 for P3 — no model picker yet. */
  modelProvider?: 'anthropic';
  modelId?: 'claude-sonnet-4-6';
}

const DEFAULT_PROVIDER = 'anthropic' as const;
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6' as const;

function toSdkThinkingLevel(level: ThinkingLevel): 'off' | 'low' | 'medium' | 'high' {
  switch (level) {
    case 'off':
    case 'low':
    case 'medium':
    case 'high':
      return level;
    case 'minimal':
      return 'low';
    case 'xhigh':
      return 'high';
  }
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Read the textual portion of a tool argument for the card label. */
function extractToolArg(args: unknown): string {
  if (args == null || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  // Common shapes across read/edit/bash/grep/glob tools.
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.file_path === 'string') return obj.file_path;
  if (typeof obj.filename === 'string') return obj.filename;
  if (typeof obj.command === 'string') return obj.command;
  if (typeof obj.cmd === 'string') return obj.cmd;
  if (typeof obj.pattern === 'string') return obj.pattern;
  if (typeof obj.query === 'string') return obj.query;
  return '';
}

/** Best-effort preview string from a tool's structured result. */
function extractToolPreview(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') return truncate(result);
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.content === 'string') return truncate(r.content);
    if (typeof r.output === 'string') return truncate(r.output);
    if (typeof r.stdout === 'string') return truncate(r.stdout);
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter((c): c is { type: 'text'; text: string } =>
          !!c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text' &&
          typeof (c as Record<string, unknown>).text === 'string',
        )
        .map((c) => c.text)
        .join('\n');
      if (text) return truncate(text);
    }
  }
  return undefined;
}

function truncate(text: string, max = 4_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more chars)`;
}

function isModelInputKind(value: unknown): value is ModelInputKind {
  return value === 'text' || value === 'image';
}

function stripImageMetadata(images: AgentImageContent[]): AgentImageContent[] {
  return images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}

const EMPTY_USAGE: TokenUsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

interface MinimalSessionStats {
  tokens?: TokenUsageSummary;
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

function sessionStats(session: AgentSession | null): MinimalSessionStats | undefined {
  const candidate = session as (AgentSession & { getSessionStats?: () => MinimalSessionStats }) | null;
  return candidate?.getSessionStats?.();
}

export class LocalSdkBackend implements AgentBackend {
  private session: AgentSession | null = null;
  private sessionInit: Promise<void>;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly toolStartedAt = new Map<string, number>();
  private currentAssistantMessageId: string | null = null;
  private accumulatedText = '';
  private runState: AgentRunState = 'idle';
  private modelProvider: string = DEFAULT_PROVIDER;
  private modelId: string = DEFAULT_MODEL_ID;
  private thinkingLevel: ThinkingLevel = 'medium';
  private hasFatalAuth = false;

  constructor(private readonly options: LocalSdkBackendOptions) {
    if (options.modelProvider) this.modelProvider = options.modelProvider;
    if (options.modelId) this.modelId = options.modelId;
    this.sessionInit = this.initSession();
  }

  private async initSession(): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Construct the session anyway so getState/getMessages still answer.
      // First prompt() will fail loudly with a structured error.
      this.hasFatalAuth = true;
    }
    try {
      const model: Model<'anthropic-messages'> = getModel('anthropic', 'claude-sonnet-4-6');
      const { session } = await createAgentSession({
        cwd: this.options.cwd,
        model,
        thinkingLevel: toSdkThinkingLevel(this.thinkingLevel),
      });
      this.session = session;
      session.subscribe((event) => this.handleSdkEvent(event));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never include the API key in the error message even by accident.
      this.emit({ type: 'error', message: `SDK init failed: ${redact(msg)}` });
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // isolated
      }
    }
  }

  private setRunState(next: AgentRunState): void {
    if (this.runState === next) return;
    this.runState = next;
    void this.getState().then((state) =>
      this.emit({ type: 'state_changed', state }),
    );
  }

  private handleSdkEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.setRunState('thinking');
        this.emit({ type: 'agent_start' });
        return;
      case 'agent_end':
        this.setRunState('idle');
        this.emit({ type: 'agent_end' });
        this.currentAssistantMessageId = null;
        this.accumulatedText = '';
        return;
      case 'queue_update':
        this.emit({
          type: 'queue_update',
          steering: [...event.steering],
          followUp: [...event.followUp],
        });
        return;
      case 'message_start': {
        const m = event.message;
        if (m.role !== 'assistant') return;
        const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.currentAssistantMessageId = id;
        this.accumulatedText = '';
        this.emit({
          type: 'message_start',
          message: {
            id,
            role: 'assistant',
            time: nowHHMM(),
            parts: [],
          },
        });
        return;
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        if (inner.type === 'text_delta') {
          this.accumulatedText += inner.delta;
          this.setRunState('running');
          this.emit({ type: 'text_delta', messageId, delta: inner.delta });
        } else if ((inner as { type?: string }).type === 'thinking_delta') {
          const delta = (inner as { delta?: unknown }).delta;
          if (typeof delta === 'string') {
            this.setRunState('thinking');
            this.emit({ type: 'thinking_delta', messageId, delta });
          }
        }
        return;
      }
      case 'message_end': {
        const messageId = this.currentAssistantMessageId;
        if (messageId) this.emit({ type: 'message_end', messageId });
        return;
      }
      case 'tool_execution_start': {
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        this.toolStartedAt.set(event.toolCallId, Date.now());
        this.setRunState('running');
        const tool: ToolCallSummary = {
          toolCallId: event.toolCallId,
          name: event.toolName,
          arg: extractToolArg(event.args),
          status: 'running',
        };
        this.emit({ type: 'tool_execution_start', messageId, tool });
        return;
      }
      case 'tool_execution_update': {
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        const preview = extractToolPreview(event.partialResult);
        if (preview === undefined) return;
        this.emit({
          type: 'tool_execution_update',
          messageId,
          toolCallId: event.toolCallId,
          patch: { preview },
        });
        return;
      }
      case 'tool_execution_end': {
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        const durationSeconds =
          startedAt != null ? Math.max(0.1, Math.round((Date.now() - startedAt) / 100) / 10) : undefined;
        this.toolStartedAt.delete(event.toolCallId);
        this.emit({
          type: 'tool_execution_end',
          messageId,
          toolCallId: event.toolCallId,
          patch: {
            status: event.isError ? 'error' : 'ok',
            preview: extractToolPreview(event.result),
            durationSeconds,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    await this.sessionInit;
    if (this.hasFatalAuth) {
      this.emit({
        type: 'error',
        message:
          'ANTHROPIC_API_KEY is not set. Export it in your shell before running pi-desktop with PI_BACKEND=sdk-local.',
      });
      return;
    }
    if (!this.session) {
      this.emit({ type: 'error', message: 'SDK session not ready' });
      return;
    }
    try {
      await this.session.prompt(text, {
        ...(options?.images?.length ? { images: stripImageMetadata(options.images) } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message: redact(msg) });
      this.setRunState('idle');
    }
  }

  async steer(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.sessionInit;
    if (!this.session) return;
    try {
      await this.session.steer(text, images?.length ? stripImageMetadata(images) : undefined);
    } catch (err) {
      this.emit({ type: 'error', message: redact(err instanceof Error ? err.message : String(err)) });
    }
  }

  async followUp(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.sessionInit;
    if (!this.session) return;
    try {
      await this.session.followUp(text, images?.length ? stripImageMetadata(images) : undefined);
    } catch (err) {
      this.emit({ type: 'error', message: redact(err instanceof Error ? err.message : String(err)) });
    }
  }

  async abort(): Promise<void> {
    await this.sessionInit;
    if (!this.session) return;
    await this.session.abort();
    this.setRunState('idle');
  }

  async getState(): Promise<AgentState> {
    await this.sessionInit;
    const model = this.session?.state.model;
    const stats = sessionStats(this.session);
    const tokenUsage = stats?.tokens ?? EMPTY_USAGE;
    const contextWindow = stats?.contextUsage?.contextWindow ?? model?.contextWindow ?? 200_000;
    const contextTokens = stats?.contextUsage?.tokens;
    return {
      runState: this.runState,
      modelProvider: model?.provider ?? this.modelProvider,
      modelId: model?.id ?? this.modelId,
      thinkingLevel: this.thinkingLevel,
      tokensUsed: typeof contextTokens === 'number' ? contextTokens : tokenUsage.total,
      tokensMax: contextWindow,
      tokenUsage,
      costUsd: stats?.cost ?? 0,
      contextPercent: stats?.contextUsage ? stats.contextUsage.percent : 0,
      autoCompactionEnabled: this.session?.autoCompactionEnabled ?? true,
      sessionId: this.session?.sessionId ?? 'unset',
      errorMessage: this.session?.state.errorMessage,
    };
  }

  async getMessages(): Promise<AgentMessage[]> {
    // For P3 we keep the renderer authoritative on chat history (it accumulates
    // events). Returning [] here is intentional and unsurprising — the renderer
    // never calls this on the SDK backend in the P3 flow. A later phase that
    // adds resume-on-reload should map SDK messages → our flat shape here.
    return [];
  }

  async getSessionFile(): Promise<string | null> {
    await this.sessionInit;
    return this.session?.sessionFile ?? null;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    await this.sessionInit;
    const model = this.session?.state.model as
      | {
          provider?: string;
          id?: string;
          name?: string;
          reasoning?: boolean;
          input?: unknown[];
          contextWindow?: number;
        }
      | undefined;
    const id = model?.id ?? this.modelId;
    const provider = model?.provider ?? this.modelProvider;
    return [
      {
        provider,
        id,
        name: model?.name ?? id,
        reasoning: model?.reasoning ?? true,
        input: Array.isArray(model?.input) ? model.input.filter(isModelInputKind) : ['text', 'image'],
        contextWindow: model?.contextWindow ?? 200_000,
      },
    ];
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.sessionInit;
    if (!this.session) return;
    // P3 keeps Claude Sonnet hardcoded. We still accept the call so the IPC
    // surface is uniform; just record locally without swapping the SDK model.
    this.modelProvider = provider;
    this.modelId = modelId;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.sessionInit;
    this.thinkingLevel = level;
    this.session?.setThinkingLevel(toSdkThinkingLevel(level));
  }

  async newSession(): Promise<void> {
    // The SDK creates the session at construction time; a clean restart is
    // accomplished by disposing and rebuilding.
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.currentAssistantMessageId = null;
    this.accumulatedText = '';
    this.runState = 'idle';
    this.sessionInit = this.initSession();
    await this.sessionInit;
    const state = await this.getState();
    this.emit({ type: 'state_changed', state });
  }

  async switchSession(_path: string): Promise<void> {
    // Out of scope for P3; later phases will use SessionManager.switchTo.
  }

  async fork(_entryId: string): Promise<void> {
    // Out of scope for P3.
  }

  async dispose(): Promise<void> {
    await this.sessionInit;
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.listeners.clear();
  }
}

/** Defensively scrub any string that might contain an API key before emitting it. */
function redact(input: string): string {
  return input.replace(/sk-[A-Za-z0-9-_]{16,}/g, 'sk-…redacted');
}
