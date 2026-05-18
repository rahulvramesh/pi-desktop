/**
 * AgentBackend — the single contract between Electron's main process and the
 * outside-world agent. The renderer never imports an implementation from this
 * folder, only these types. Implementations live in mock.ts, local-sdk.ts, and
 * eventually rpc.ts.
 *
 * Shape matches §vi of the architecture plan verbatim. Any change here must be
 * mirrored in @shared/ipc.ts and announced to renderer + backend in lockstep.
 */

export type AgentRunState = 'idle' | 'thinking' | 'running' | 'queued';

/** Full pi set. `xhigh` is OpenAI codex-max only; pi clamps unsupported. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** A model pi has configured (built-in + ~/.pi/agent/models.json, merged). */
export type ModelInputKind = 'text' | 'image';

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Supports extended thinking — gates the thinking-effort picker. */
  reasoning: boolean;
  /** Input modalities advertised by pi's Model.input field. */
  input: ModelInputKind[];
  contextWindow: number;
}

/** Image attachment shape accepted by pi RPC and the SDK. */
export interface AgentImageContent {
  type: 'image';
  /** Base64-encoded image bytes (no data: URL prefix). */
  data: string;
  /** MIME type, e.g. image/png, image/jpeg, image/webp, image/gif. */
  mimeType: string;
  /** Renderer-only metadata for transcript thumbnails; stripped before RPC. */
  name?: string;
  size?: number;
}

export interface PromptOptions {
  /** Optional image attachments. Sent as pi ImageContent over RPC. */
  images?: AgentImageContent[];
  /** When streaming, how to queue: "steer" interrupts, "followUp" waits. */
  streamingBehavior?: 'steer' | 'followUp';
}

/**
 * Snapshot of the agent's surface state. Serializable across IPC.
 * Internal SDK shapes (Model, Tool, etc.) get flattened to plain identifiers.
 */
export interface TokenUsageSummary {
  /** Input tokens billed/recorded by assistant responses. */
  input: number;
  /** Output tokens billed/recorded by assistant responses. */
  output: number;
  /** Prompt-cache read tokens. */
  cacheRead: number;
  /** Prompt-cache write tokens. */
  cacheWrite: number;
  /** Total = input + output + cacheRead + cacheWrite. */
  total: number;
}

export interface AgentState {
  runState: AgentRunState;
  modelProvider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Current context usage estimate, or token total when context usage is unavailable. */
  tokensUsed: number;
  /** Context window size for the active model. */
  tokensMax: number;
  /** Full session token accounting from pi get_session_stats. */
  tokenUsage: TokenUsageSummary;
  /** Total session cost in USD, as reported by pi. */
  costUsd: number;
  /** Current context-window percentage; null after compaction until next LLM response. */
  contextPercent: number | null;
  /** Whether pi auto-compaction is enabled. */
  autoCompactionEnabled: boolean;
  sessionId: string;
  errorMessage?: string;
}

/**
 * Tool-call result preview rendered in the chat. Each backend produces a
 * `preview` string that is safe to drop into a <pre> in the renderer.
 */
export interface ToolCallSummary {
  toolCallId: string;
  /** Tool name verbatim: "read", "edit", "bash", "grep", ... */
  name: string;
  /** Human argument — file path for read/edit, command for bash, query for grep. */
  arg: string;
  status: 'running' | 'ok' | 'error';
  /** Truncated preview of stdout/stderr/diff produced by the tool, if any. */
  preview?: string;
  /** Edit/diff tools may set this for the line-count badge. */
  stats?: { add: number; del: number };
  /** Time in seconds, rounded to one decimal, once the tool has finished. */
  durationSeconds?: number;
}

/**
 * An ordered fragment of a message. A message is a timeline of these in the
 * exact order they streamed in — text, reasoning, and tool calls interleaved
 * as they actually occurred (not bucketed by kind), so the transcript reads
 * chronologically including the final answer.
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; image: AgentImageContent }
  | { kind: 'tool'; tool: ToolCallSummary };

/**
 * A message record. `parts` is the chronological timeline; consecutive deltas
 * of the same kind coalesce into the trailing part, and a kind switch (text →
 * thinking → tool → text …) opens a new part, preserving arrival order.
 */
export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Wall-clock display string, e.g. "10:42". */
  time: string;
  parts: MessagePart[];
}

/**
 * Events the backend pushes to the main process and, via IPC, to the renderer.
 * Shape is intentionally narrow and serializable. Streaming text is delivered
 * as `text_delta` chunks; the main process batches these in ~16ms windows
 * before crossing the IPC boundary, per §viii of the plan.
 */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'state_changed'; state: AgentState }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'thinking_delta'; messageId: string; delta: string }
  | { type: 'message_end'; messageId: string }
  | {
      type: 'tool_execution_start';
      messageId: string;
      tool: ToolCallSummary;
    }
  | {
      type: 'tool_execution_update';
      messageId: string;
      toolCallId: string;
      patch: Partial<ToolCallSummary>;
    }
  | {
      type: 'tool_execution_end';
      messageId: string;
      toolCallId: string;
      patch: Partial<ToolCallSummary>;
    }
  | { type: 'error'; message: string };

export type AgentEventListener = (event: AgentEvent) => void;

export type RpcLogDirection = 'request' | 'response' | 'event' | 'stdout' | 'stderr';

/**
 * Developer-mode trace entry for the JSONL RPC transport (`pi --mode rpc`).
 * Entries are redacted/truncated by the backend before crossing IPC.
 */
export interface RpcLogEntry {
  id: string;
  timestamp: number;
  direction: RpcLogDirection;
  /** The RPC command/event type, e.g. prompt, get_state, message_update. */
  method?: string;
  /** Request id (`r-…`) when the command expects a response. */
  requestId?: string;
  /** Whether the source command expected a response. Present on requests. */
  expectResponse?: boolean;
  /** Response success bit, if this is an RPC response. */
  success?: boolean;
  /** Round-trip time from request write to response read, when known. */
  durationMs?: number;
  /** Redacted JSONL line or stderr/stdout chunk. May be truncated for safety. */
  raw: string;
  /** Parsed + redacted payload for structured display, when available. */
  payload?: unknown;
  error?: string;
}

export type RpcLogListener = (entry: RpcLogEntry) => void;

/**
 * The contract. Adding a method here requires an IPC change and renderer
 * support; that's deliberate, the renderer is the only direct consumer.
 */
export interface AgentBackend {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string, images?: AgentImageContent[]): Promise<void>;
  followUp(text: string, images?: AgentImageContent[]): Promise<void>;
  abort(): Promise<void>;

  subscribe(listener: AgentEventListener): () => void;

  /** Optional developer-mode RPC trace stream. Implemented by RpcBackend only. */
  subscribeRpcLogs?(listener: RpcLogListener): () => void;

  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;

  /** Models pi has configured (for the composer's model picker). */
  getAvailableModels(): Promise<ModelInfo[]>;

  /**
   * The pi JSONL session file backing the active conversation, or null if not
   * yet known / not applicable. Main-process only — used to persist a chat's
   * resume pointer; never crosses IPC.
   */
  getSessionFile(): Promise<string | null>;

  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;

  newSession(): Promise<void>;
  switchSession(path: string): Promise<void>;
  fork(entryId: string): Promise<void>;

  dispose(): Promise<void>;
}

/** Discriminated config used by the factory in factory.ts. */
export type AgentBackendConfig =
  | { kind: 'mock' }
  | { kind: 'sdk-local'; cwd: string }
  | { kind: 'rpc-local'; cwd: string }
  | { kind: 'rpc-ssh'; host: string; cwd: string }
  | { kind: 'proxy'; chatId: string; projectId: string; cwd: string; title?: string };
