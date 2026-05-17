/**
 * RpcBackend — drives the user's *installed* pi via `pi --mode rpc`.
 *
 * We deliberately spawn the user's own pi binary (not the bundled SDK) so the
 * agent reuses their existing auth (`~/.pi/agent/auth.json`), models, skills,
 * and extensions. The subprocess is spawned with `cwd` set to the project
 * folder, which is what makes the agent operate on that project's files.
 *
 * Protocol: JSON commands to stdin (one per line), JSON events/responses from
 * stdout (one per line). Per the RPC spec, framing is strict LF only — we MUST
 * NOT use Node `readline` (it also splits on U+2028/U+2029, which are legal
 * inside JSON strings). We hand-roll a buffer-and-split reader instead.
 *
 * Event mapping mirrors local-sdk.ts: the RPC `message_update.
 * assistantMessageEvent` / `tool_execution_*` shapes are identical to the SDK's,
 * so both backends normalize to the same flat AgentEvent union.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentImageContent,
  AgentMessage,
  AgentRunState,
  AgentState,
  MessagePart,
  ModelInfo,
  ModelInputKind,
  PromptOptions,
  RpcLogEntry,
  RpcLogListener,
  ThinkingLevel,
  ToolCallSummary,
} from './backend.js';

export interface RpcSpawn {
  command: string;
  args: string[];
}

export interface RpcBackendOptions {
  /** How to launch the agent. Local: `pi --mode rpc`. SSH: `ssh host pi …`. */
  spawn: RpcSpawn;
  /** Working directory for the agent (the project folder). */
  cwd: string;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

interface RequestTrace {
  method: string;
  startedAt: number;
}

const MAX_RPC_LOG_STRING = 80_000;
const MAX_RPC_LOG_KEYS = 200;
const MAX_RPC_LOG_ARRAY_ITEMS = 500;
const MAX_RPC_LOG_DEPTH = 8;

function nowHHMM(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function extractToolArg(args: unknown): string {
  if (args == null || typeof args !== 'object') return '';
  const o = args as Record<string, unknown>;
  for (const k of ['path', 'file_path', 'filename', 'command', 'cmd', 'pattern', 'query']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}

function truncate(text: string, max = 4_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more chars)`;
}

function extractToolPreview(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') return truncate(result);
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.content === 'string') return truncate(r.content);
    if (typeof r.output === 'string') return truncate(r.output);
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            !!c &&
            typeof c === 'object' &&
            (c as Record<string, unknown>).type === 'text' &&
            typeof (c as Record<string, unknown>).text === 'string',
        )
        .map((c) => c.text)
        .join('\n');
      if (text) return truncate(text);
    }
  }
  return undefined;
}

/** Scrub anything that looks like a secret before it leaves this process. */
function redact(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9-_]{16,}/g, 'sk-…redacted')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer …redacted');
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[\s.-]/g, '_').toLowerCase();
  return /(^|_)(api_?key|access_?token|refresh_?token|id_?token|auth_?token|authorization|password|secret|credential|cookie)($|_)/.test(
    normalized,
  );
}

function redactAndTrim(input: string, max = MAX_RPC_LOG_STRING): string {
  const redacted = redact(input);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}\n… (${redacted.length - max} more chars truncated)`;
}

function sanitizeForRpcLog(input: unknown, depth = 0): unknown {
  if (typeof input === 'string') return redactAndTrim(input);
  if (input == null || typeof input === 'number' || typeof input === 'boolean') return input;
  if (depth >= MAX_RPC_LOG_DEPTH) return '[Max depth reached]';
  if (Array.isArray(input)) {
    const out = input
      .slice(0, MAX_RPC_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeForRpcLog(item, depth + 1));
    if (input.length > MAX_RPC_LOG_ARRAY_ITEMS) {
      out.push(`… (${input.length - MAX_RPC_LOG_ARRAY_ITEMS} more items truncated)`);
    }
    return out;
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const entries = Object.entries(obj);
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries.slice(0, MAX_RPC_LOG_KEYS)) {
      if (obj.type === 'image' && key === 'data' && typeof value === 'string') {
        out[key] = `…base64 image omitted (${value.length} chars)`;
      } else {
        out[key] = isSensitiveKey(key) ? '…redacted' : sanitizeForRpcLog(value, depth + 1);
      }
    }
    if (entries.length > MAX_RPC_LOG_KEYS) {
      out['__truncated__'] = `${entries.length - MAX_RPC_LOG_KEYS} more keys truncated`;
    }
    return out;
  }
  return String(input);
}

function rpcMethod(payload: Record<string, unknown>): string | undefined {
  return typeof payload.type === 'string' ? payload.type : undefined;
}

function rawForRpcLog(payload: unknown): string {
  try {
    const raw = JSON.stringify(sanitizeForRpcLog(payload));
    return redactAndTrim(raw ?? String(payload));
  } catch {
    return redactAndTrim(String(payload));
  }
}

function contentToParts(content: unknown): MessagePart[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const o = block as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') {
      const last = parts[parts.length - 1];
      if (last && last.kind === 'text') last.text += o.text;
      else parts.push({ kind: 'text', text: o.text });
    } else if (o.type === 'image' && typeof o.data === 'string' && typeof o.mimeType === 'string') {
      parts.push({
        kind: 'image',
        image: {
          type: 'image',
          data: o.data,
          mimeType: o.mimeType,
          ...(typeof o.name === 'string' ? { name: o.name } : {}),
          ...(typeof o.size === 'number' ? { size: o.size } : {}),
        },
      });
    }
  }
  return parts;
}

function isModelInputKind(value: unknown): value is ModelInputKind {
  return value === 'text' || value === 'image';
}

function stripImageMetadata(images: AgentImageContent[]): AgentImageContent[] {
  return images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export class RpcBackend implements AgentBackend {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly rpcLogListeners = new Set<RpcLogListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTrace = new Map<string, RequestTrace>();
  private reqId = 0;
  private rpcLogSeq = 0;
  private stdoutBuf = '';
  private readonly decoder = new StringDecoder('utf8');
  private stderr = '';

  private runState: AgentRunState = 'idle';
  private currentAssistantMessageId: string | null = null;
  private modelProvider = 'unknown';
  private modelId = 'unknown';
  private thinkingLevel: ThinkingLevel = 'medium';
  private contextWindow = 200_000;
  private contextTokens: number | null = 0;
  private contextPercent: number | null = 0;
  private tokenUsage = EMPTY_USAGE;
  private costUsd = 0;
  private autoCompactionEnabled = true;
  private sessionId = 'pending';
  private sessionFile: string | null = null;
  private disposed = false;

  constructor(private readonly options: RpcBackendOptions) {}

  // --- lifecycle ---------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      try {
        const child = spawn(this.options.spawn.command, this.options.spawn.args, {
          cwd: this.options.cwd,
          env: process.env,
          // shell:true lets Windows resolve the `pi.cmd` PATH shim. The command
          // and args are static (no user input), and cwd is passed as a spawn
          // option, not interpolated into the shell line — so this is safe.
          shell: process.platform === 'win32',
        }) as ChildProcessWithoutNullStreams;
        this.proc = child;

        child.on('error', (err) => {
          const msg = `Failed to launch the pi agent (${this.options.spawn.command}). Is pi installed and on PATH? ${redact(
            err.message,
          )}`;
          this.emit({ type: 'error', message: msg });
          reject(new Error(msg));
        });

        child.on('exit', (code) => {
          this.proc = null;
          this.setRunState('idle');
          for (const [, p] of this.pending) p.reject(new Error('pi agent exited'));
          this.pending.clear();
          this.requestTrace.clear();
          if (!this.disposed && code !== 0 && code !== null) {
            this.emit({
              type: 'error',
              message: `pi agent exited (code ${code}).${
                this.stderr ? ` ${redact(this.stderr.slice(-500))}` : ''
              }`,
            });
          }
        });

        child.stderr.on('data', (d: Buffer) => {
          const chunk = d.toString('utf8');
          this.stderr += chunk;
          if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
          this.emitRpcLog({ direction: 'stderr', raw: redactAndTrim(chunk) });
        });

        child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));

        // The process is up once spawned; pi is ready to accept commands on
        // stdin immediately. Resolve on next tick so 'error' can pre-empt.
        setImmediate(() => {
          if (this.proc) resolve();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return this.startPromise;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += this.decoder.write(chunk);
    // Strict JSONL: split on \n only, tolerate a trailing \r.
    for (;;) {
      const nl = this.stdoutBuf.indexOf('\n');
      if (nl === -1) break;
      let line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emitRpcLog({ direction: 'stdout', raw: redactAndTrim(line) });
      return;
    }
    if (msg.type === 'response') {
      const id = typeof msg.id === 'string' ? msg.id : null;
      const trace = id ? this.requestTrace.get(id) : undefined;
      if (id) this.requestTrace.delete(id);
      this.emitRpcLog({
        direction: 'response',
        requestId: id ?? undefined,
        method: trace?.method,
        success: msg.success !== false,
        durationMs: trace ? Date.now() - trace.startedAt : undefined,
        raw: rawForRpcLog(msg),
        payload: sanitizeForRpcLog(msg),
        error: typeof msg.error === 'string' ? redactAndTrim(msg.error) : undefined,
      });
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.success === false) {
          p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'RPC command failed'));
        } else {
          p.resolve(msg.data);
        }
      }
      return;
    }
    this.emitRpcLog({
      direction: 'event',
      method: rpcMethod(msg),
      raw: rawForRpcLog(msg),
      payload: sanitizeForRpcLog(msg),
    });
    this.handleEvent(msg);
  }

  // --- event mapping (RPC -> flat AgentEvent) ----------------------------

  /**
   * One assistant bubble per agent run. pi emits a `message_start`/
   * `message_end` per turn (each LLM call in an agentic loop); collapsing them
   * into a single message — opened lazily, closed at `agent_end` — matches the
   * mock backend and the design (text + all tool cards under one "Pi" message
   * instead of one bubble per turn).
   */
  private startAssistantMessage(): string {
    if (this.currentAssistantMessageId) return this.currentAssistantMessageId;
    const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentAssistantMessageId = id;
    this.emit({
      type: 'message_start',
      message: { id, role: 'assistant', time: nowHHMM(), parts: [] },
    });
    return id;
  }

  private handleEvent(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'agent_start':
        this.currentAssistantMessageId = null;
        this.setRunState('thinking');
        this.emit({ type: 'agent_start' });
        return;
      case 'agent_end':
        if (this.currentAssistantMessageId) {
          this.emit({ type: 'message_end', messageId: this.currentAssistantMessageId });
        }
        this.setRunState('idle');
        this.emit({ type: 'agent_end' });
        this.currentAssistantMessageId = null;
        return;
      case 'queue_update': {
        const steering = Array.isArray(ev.steering)
          ? ev.steering.filter((m): m is string => typeof m === 'string')
          : [];
        const followUp = Array.isArray(ev.followUp)
          ? ev.followUp.filter((m): m is string => typeof m === 'string')
          : [];
        this.emit({ type: 'queue_update', steering, followUp });
        return;
      }
      case 'message_start': {
        const m = ev.message as { role?: string } | undefined;
        if (!m || m.role !== 'assistant') return;
        if (this.currentAssistantMessageId == null) {
          this.startAssistantMessage();
        } else {
          // Continuation turn within the same run: one bubble, but keep
          // successive turns' prose visually separated.
          this.emit({
            type: 'text_delta',
            messageId: this.currentAssistantMessageId,
            delta: '\n\n',
          });
        }
        return;
      }
      case 'message_update': {
        const inner = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (!inner) return;
        if (inner.type === 'text_delta' && typeof inner.delta === 'string') {
          const messageId = this.startAssistantMessage();
          this.setRunState('running');
          this.emit({ type: 'text_delta', messageId, delta: inner.delta });
        } else if (inner.type === 'thinking_delta' && typeof inner.delta === 'string') {
          const messageId = this.startAssistantMessage();
          this.setRunState('thinking');
          this.emit({ type: 'thinking_delta', messageId, delta: inner.delta });
        } else if (inner.type === 'error') {
          this.emit({ type: 'error', message: 'assistant message error' });
        }
        return;
      }
      case 'message_end':
        // Turn boundary, not run boundary — the bubble stays open until
        // agent_end. Intentionally ignored.
        return;
      case 'tool_execution_start': {
        const messageId = this.startAssistantMessage();
        this.setRunState('running');
        const tool: ToolCallSummary = {
          toolCallId: String(ev.toolCallId),
          name: String(ev.toolName),
          arg: extractToolArg(ev.args),
          status: 'running',
        };
        this.emit({ type: 'tool_execution_start', messageId, tool });
        return;
      }
      case 'tool_execution_update': {
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        const preview = extractToolPreview(ev.partialResult);
        if (preview === undefined) return;
        this.emit({
          type: 'tool_execution_update',
          messageId,
          toolCallId: String(ev.toolCallId),
          patch: { preview },
        });
        return;
      }
      case 'tool_execution_end': {
        const messageId = this.currentAssistantMessageId;
        if (!messageId) return;
        this.emit({
          type: 'tool_execution_end',
          messageId,
          toolCallId: String(ev.toolCallId),
          patch: {
            status: ev.isError ? 'error' : 'ok',
            preview: extractToolPreview(ev.result),
          },
        });
        return;
      }
      default:
        return;
    }
  }

  // --- command plumbing --------------------------------------------------

  private send(command: Record<string, unknown>, expectResponse: boolean): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('pi agent not running'));
    const method = rpcMethod(command);
    if (!expectResponse) {
      const raw = JSON.stringify(command);
      this.emitRpcLog({
        direction: 'request',
        method,
        expectResponse,
        raw: rawForRpcLog(command),
        payload: sanitizeForRpcLog(command),
      });
      this.proc.stdin.write(`${raw}\n`);
      return Promise.resolve(undefined);
    }
    const id = `r-${++this.reqId}`;
    const payload = { ...command, id };
    const raw = JSON.stringify(payload);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.requestTrace.set(id, { method: method ?? 'unknown', startedAt: Date.now() });
      this.emitRpcLog({
        direction: 'request',
        requestId: id,
        method,
        expectResponse,
        raw: rawForRpcLog(payload),
        payload: sanitizeForRpcLog(payload),
      });
      this.proc!.stdin.write(`${raw}\n`);
    });
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
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // isolated
      }
    }
  }

  private emitRpcLog(entry: Omit<RpcLogEntry, 'id' | 'timestamp'>): void {
    const full: RpcLogEntry = {
      id: `rpc-${Date.now()}-${++this.rpcLogSeq}`,
      timestamp: Date.now(),
      ...entry,
    };
    for (const l of this.rpcLogListeners) {
      try {
        l(full);
      } catch {
        // isolated
      }
    }
  }

  private setRunState(next: AgentRunState): void {
    if (this.runState === next) return;
    this.runState = next;
    void this.getState().then((state) => this.emit({ type: 'state_changed', state }));
  }

  private applySessionStats(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const stats = data as Record<string, unknown>;
    const tokens = stats.tokens;
    if (tokens && typeof tokens === 'object') {
      const t = tokens as Record<string, unknown>;
      const input = typeof t.input === 'number' ? t.input : 0;
      const output = typeof t.output === 'number' ? t.output : 0;
      const cacheRead = typeof t.cacheRead === 'number' ? t.cacheRead : 0;
      const cacheWrite = typeof t.cacheWrite === 'number' ? t.cacheWrite : 0;
      const total = typeof t.total === 'number' ? t.total : input + output + cacheRead + cacheWrite;
      this.tokenUsage = { input, output, cacheRead, cacheWrite, total };
    }
    if (typeof stats.cost === 'number') this.costUsd = stats.cost;
    const contextUsage = stats.contextUsage;
    if (contextUsage && typeof contextUsage === 'object') {
      const c = contextUsage as Record<string, unknown>;
      if (typeof c.contextWindow === 'number') this.contextWindow = c.contextWindow;
      this.contextTokens = typeof c.tokens === 'number' ? c.tokens : null;
      this.contextPercent = typeof c.percent === 'number' ? c.percent : null;
    }
  }

  // --- AgentBackend ------------------------------------------------------

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    await this.ensureStarted();
    const cmd: Record<string, unknown> = { type: 'prompt', message: text };
    if (options?.images?.length) cmd.images = stripImageMetadata(options.images);
    if (options?.streamingBehavior) cmd.streamingBehavior = options.streamingBehavior;
    try {
      await this.send(cmd, true);
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async steer(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.ensureStarted();
    try {
      const cmd: Record<string, unknown> = { type: 'steer', message: text };
      if (images?.length) cmd.images = stripImageMetadata(images);
      await this.send(cmd, true);
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async followUp(text: string, images?: AgentImageContent[]): Promise<void> {
    await this.ensureStarted();
    try {
      const cmd: Record<string, unknown> = { type: 'follow_up', message: text };
      if (images?.length) cmd.images = stripImageMetadata(images);
      await this.send(cmd, true);
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async abort(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.send({ type: 'abort' }, true);
    } catch {
      // abort while idle is a no-op for pi
    }
    this.setRunState('idle');
  }

  async getState(): Promise<AgentState> {
    if (!this.disposed) {
      try {
        await this.ensureStarted();
      } catch {
        // Launch failures are surfaced through the error event emitted by
        // ensureStarted(); keep returning the cached snapshot so UI reads remain
        // safe while the banner shows the actual startup error.
      }
    }

    if (this.proc) {
      try {
        const data = (await this.send({ type: 'get_state' }, true)) as
          | {
              model?: { provider?: string; id?: string; contextWindow?: number } | null;
              thinkingLevel?: ThinkingLevel;
              sessionId?: string;
              sessionFile?: string;
              autoCompactionEnabled?: boolean;
            }
          | undefined;
        if (data) {
          if (data.model) {
            this.modelProvider = data.model.provider ?? this.modelProvider;
            this.modelId = data.model.id ?? this.modelId;
            this.contextWindow = data.model.contextWindow ?? this.contextWindow;
          }
          if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
          if (data.sessionId) this.sessionId = data.sessionId;
          if (typeof data.sessionFile === 'string') this.sessionFile = data.sessionFile;
          if (typeof data.autoCompactionEnabled === 'boolean') {
            this.autoCompactionEnabled = data.autoCompactionEnabled;
          }
        }
      } catch {
        // fall through to cached values
      }
      try {
        this.applySessionStats(await this.send({ type: 'get_session_stats' }, true));
      } catch {
        // Older pi or startup failures may not answer stats; keep cached zeros.
      }
    }
    return {
      runState: this.runState,
      modelProvider: this.modelProvider,
      modelId: this.modelId,
      thinkingLevel: this.thinkingLevel,
      tokensUsed: typeof this.contextTokens === 'number' ? this.contextTokens : this.tokenUsage.total,
      tokensMax: this.contextWindow,
      tokenUsage: this.tokenUsage,
      costUsd: this.costUsd,
      contextPercent: this.contextPercent,
      autoCompactionEnabled: this.autoCompactionEnabled,
      sessionId: this.sessionId,
    };
  }

  /** Main-process only (not over IPC): the pi JSONL session file, once known. */
  async getSessionFile(): Promise<string | null> {
    await this.getState();
    return this.sessionFile;
  }

  async getMessages(): Promise<AgentMessage[]> {
    if (!this.proc) return [];
    let data: { messages?: unknown[] } | undefined;
    try {
      data = (await this.send({ type: 'get_messages' }, true)) as { messages?: unknown[] };
    } catch {
      return [];
    }
    const raw = Array.isArray(data?.messages) ? data!.messages : [];
    const out: AgentMessage[] = [];
    // Collapse a run's many pi assistant/toolResult messages into one bubble
    // (matches the live event mapping). `cur` is pushed once when the run's
    // first assistant message appears, then mutated in place.
    let cur: AgentMessage | null = null;
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      const o = m as Record<string, unknown>;
      const time = nowHHMM(
        typeof o.timestamp === 'number' ? new Date(o.timestamp) : new Date(),
      );
      if (o.role === 'user') {
        cur = null;
        out.push({
          id: `u-${out.length}-${o.timestamp ?? ''}`,
          role: 'user',
          time,
          parts: contentToParts(o.content),
        });
      } else if (o.role === 'assistant') {
        if (!cur) {
          cur = {
            id: `a-${out.length}-${o.timestamp ?? ''}`,
            role: 'assistant',
            time,
            parts: [],
          };
          out.push(cur);
        }
        // pi's content blocks are already chronological; emit parts in that
        // exact order, coalescing consecutive text/thinking runs.
        const pushDelta = (kind: 'text' | 'thinking', text: string) => {
          const last = cur!.parts[cur!.parts.length - 1];
          if (last && last.kind === kind) last.text += text;
          else cur!.parts.push({ kind, text });
        };
        const blocks = Array.isArray(o.content) ? o.content : [];
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue;
          const bb = b as Record<string, unknown>;
          if (bb.type === 'text' && typeof bb.text === 'string') pushDelta('text', bb.text);
          else if (bb.type === 'thinking' && typeof bb.thinking === 'string') {
            pushDelta('thinking', bb.thinking);
          } else if (bb.type === 'toolCall') {
            cur.parts.push({
              kind: 'tool',
              tool: {
                toolCallId: String(bb.id),
                name: String(bb.name),
                arg: extractToolArg(bb.arguments),
                status: 'ok',
              },
            });
          }
        }
      } else if (o.role === 'toolResult') {
        const tcId = String(o.toolCallId);
        const findToolPart = (msg: AgentMessage) =>
          msg.parts.find(
            (p): p is Extract<MessagePart, { kind: 'tool' }> =>
              p.kind === 'tool' && p.tool.toolCallId === tcId,
          );
        let part = cur ? findToolPart(cur) : undefined;
        if (!part) {
          for (let i = out.length - 1; i >= 0 && !part; i--) {
            const prev = out[i];
            if (prev) part = findToolPart(prev);
          }
        }
        if (part) {
          // Pass the whole toolResult object: extractToolPreview reads `.content`
          // (an array of {type:'text'} blocks); passing the array directly here
          // was the "no tool output after refresh" bug.
          part.tool.preview = extractToolPreview(o);
          part.tool.status = o.isError ? 'error' : 'ok';
        }
      }
    }
    return out;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    if (this.disposed) return [];
    try {
      await this.ensureStarted();
    } catch {
      return [];
    }
    if (!this.proc) return [];
    try {
      const data = (await this.send({ type: 'get_available_models' }, true)) as
        | { models?: unknown[] }
        | undefined;
      const raw = Array.isArray(data?.models) ? data!.models : [];
      const out: ModelInfo[] = [];
      for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const o = m as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : null;
        const provider = typeof o.provider === 'string' ? o.provider : null;
        if (!id || !provider) continue;
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
    } catch {
      return [];
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.send({ type: 'set_model', provider, modelId }, true);
      this.modelProvider = provider;
      this.modelId = modelId;
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.ensureStarted();
    this.thinkingLevel = level;
    try {
      await this.send({ type: 'set_thinking_level', level }, true);
    } catch {
      // non-fatal
    }
  }

  async newSession(): Promise<void> {
    await this.ensureStarted();
    try {
      await this.send({ type: 'new_session' }, true);
      this.sessionFile = null;
      this.currentAssistantMessageId = null;
      const state = await this.getState();
      this.emit({ type: 'state_changed', state });
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async switchSession(path: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.send({ type: 'switch_session', sessionPath: path }, true);
      this.sessionFile = path;
      this.currentAssistantMessageId = null;
      const state = await this.getState();
      this.emit({ type: 'state_changed', state });
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async fork(entryId: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.send({ type: 'fork', entryId }, true);
    } catch (err) {
      this.emit({
        type: 'error',
        message: redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      if (this.proc) {
        await this.send({ type: 'abort' }, false).catch(() => {});
        this.proc.stdin.end();
        this.proc.kill();
      }
    } finally {
      this.proc = null;
      this.startPromise = null;
      this.listeners.clear();
      this.rpcLogListeners.clear();
      this.pending.clear();
      this.requestTrace.clear();
    }
  }
}
