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

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface PromptOptions {
  /** Optional image attachments as data URLs. */
  images?: string[];
  /** When streaming, how to queue: "steer" interrupts, "followUp" waits. */
  streamingBehavior?: 'steer' | 'followUp';
}

/**
 * Snapshot of the agent's surface state. Serializable across IPC.
 * Internal SDK shapes (Model, Tool, etc.) get flattened to plain identifiers.
 */
export interface AgentState {
  runState: AgentRunState;
  modelProvider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Total prompt+completion tokens used so far in this session. */
  tokensUsed: number;
  /** Context window size for the active model. */
  tokensMax: number;
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
 * Plain-text message record persisted across renderer reloads. The renderer
 * appends streamed text into the last assistant message as text_delta events
 * arrive; tool cards live on the assistant message that requested them.
 */
export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Wall-clock display string, e.g. "10:42". */
  time: string;
  text: string;
  toolCalls: ToolCallSummary[];
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
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'text_delta'; messageId: string; delta: string }
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

/**
 * The contract. Adding a method here requires an IPC change and renderer
 * support; that's deliberate, the renderer is the only direct consumer.
 */
export interface AgentBackend {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;

  subscribe(listener: AgentEventListener): () => void;

  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;

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
  | { kind: 'rpc-local' }
  | { kind: 'rpc-ssh'; host: string };
