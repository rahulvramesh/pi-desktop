/**
 * Agent store — chat messages + run state + tool cards.
 *
 * Subscribes to piClient.subscribe on first read. Streamed text_delta events
 * are appended directly to the matching assistant message; tool_execution_*
 * events mutate the per-message toolCalls array.
 *
 * The renderer is the source of truth for displayed chat history; the main
 * process replays its own state on reload via getMessages() (used by the
 * MockBackend; LocalSdkBackend defers this to later phases).
 */

import { create } from 'zustand';
import { piClient } from '../client/pi-client.js';
import type { AgentEventEnvelope } from '../../shared/ipc.js';
import type {
  AgentEvent,
  AgentImageContent,
  AgentMessage,
  AgentRunState,
  AgentState,
  MessagePart,
  ModelInfo,
  PromptOptions,
  ThinkingLevel,
  ToolCallSummary,
} from '../../agent/backend.js';

export type QueuedMessageKind = 'steer' | 'followUp';
export type QueuedMessageStatus = 'pending' | 'queued';

export interface DisplayMessage extends AgentMessage {
  queue?: {
    kind: QueuedMessageKind;
    status: QueuedMessageStatus;
    text: string;
    createdAt: number;
  };
}

interface AgentStoreState {
  /** Latest snapshot of agent state (model, tokens, runState). */
  state: AgentState;
  /** Whether the agent is currently streaming a response. */
  runState: AgentRunState;
  /** Active chat id, if one has been opened. */
  activeChatId: string | null;
  /** Ordered chat transcript for the active chat. */
  messages: DisplayMessage[];
  /** Warm transcript cache keyed by chat id for background event updates. */
  messagesByChat: Record<string, DisplayMessage[]>;
  /** Warm state cache keyed by chat id for background event updates. */
  stateByChat: Record<string, AgentState>;
  /** Non-fatal info/error banner; consumed by chat composer footer. */
  lastError: string | null;
  /** True once subscribe() has been wired. */
  subscribed: boolean;
  /** Models pi has configured (for the composer's model picker). */
  models: ModelInfo[];

  ensureSubscribed(): void;
  sendPrompt(
    text: string,
    images?: AgentImageContent[],
    streamingBehavior?: PromptOptions['streamingBehavior'],
  ): Promise<void>;
  abort(): Promise<void>;
  clearError(): void;
  /** Replace the transcript with the active chat's history (after chat:open). */
  loadActiveChat(chatId?: string): Promise<void>;
  loadModels(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  discardQueuedMessage(messageId: string): void;
}

const INITIAL_STATE: AgentState = {
  runState: 'idle',
  modelProvider: 'mock',
  modelId: 'mock-sonnet',
  thinkingLevel: 'medium',
  tokensUsed: 0,
  tokensMax: 200_000,
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  contextPercent: 0,
  autoCompactionEnabled: true,
  sessionId: 'pending',
};

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function cloneParts(parts: MessagePart[]): MessagePart[] {
  return parts.map((p) => {
    if (p.kind === 'tool') return { kind: 'tool', tool: { ...p.tool } };
    if (p.kind === 'image') return { kind: 'image', image: { ...p.image } };
    return { ...p };
  });
}

/** Append a streamed delta, coalescing into the trailing part of the same kind
 *  or opening a new part when the kind switches — this is what preserves the
 *  true chronological order (text / thinking / tool interleaved). */
function appendDelta(msg: DisplayMessage, kind: 'text' | 'thinking', delta: string): DisplayMessage {
  const parts = msg.parts.slice();
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    parts[parts.length - 1] = { kind, text: last.text + delta };
  } else {
    parts.push({ kind, text: delta });
  }
  return { ...msg, parts };
}

function withMessage(
  state: AgentStoreState,
  messageId: string,
  fn: (m: DisplayMessage) => DisplayMessage,
): Partial<AgentStoreState> {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return {};
  const existing = state.messages[idx];
  if (!existing) return {};
  const next = state.messages.slice();
  next[idx] = fn(existing);
  return { messages: next };
}

function messageText(message: DisplayMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function withoutQueue(message: DisplayMessage): DisplayMessage {
  const { queue: _queue, ...rest } = message;
  return rest;
}

function applyQueueUpdate(
  state: AgentStoreState,
  steering: string[],
  followUp: string[],
): Partial<AgentStoreState> {
  const remaining: Record<QueuedMessageKind, string[]> = {
    steer: [...steering],
    followUp: [...followUp],
  };
  let changed = false;
  const messages = state.messages.map((m) => {
    if (!m.queue) return m;
    const text = m.queue.text || messageText(m);
    const queue = remaining[m.queue.kind];
    const idx = queue.indexOf(text);
    if (idx >= 0) {
      queue.splice(idx, 1);
      if (m.queue.status === 'queued') return m;
      changed = true;
      return { ...m, queue: { ...m.queue, status: 'queued' as const } };
    }
    if (m.queue.status === 'queued') {
      changed = true;
      return withoutQueue(m);
    }
    return m;
  });
  return changed ? { messages } : {};
}

function applyEvent(state: AgentStoreState, event: AgentEvent): Partial<AgentStoreState> {
  switch (event.type) {
    case 'agent_start':
      return { runState: 'thinking' };
    case 'agent_end':
      return { runState: 'idle' };
    case 'state_changed':
      return { state: event.state, runState: event.state.runState };
    case 'queue_update':
      return applyQueueUpdate(state, event.steering, event.followUp);
    case 'message_start': {
      // Avoid double-inserting if the renderer also pushed the user message.
      const exists = state.messages.some((m) => m.id === event.message.id);
      if (exists) return {};
      return {
        messages: [
          ...state.messages,
          { ...event.message, parts: cloneParts(event.message.parts) },
        ],
      };
    }
    case 'text_delta':
      return withMessage(state, event.messageId, (m) => appendDelta(m, 'text', event.delta));
    case 'thinking_delta':
      return withMessage(state, event.messageId, (m) => appendDelta(m, 'thinking', event.delta));
    case 'message_end':
      return {};
    case 'tool_execution_start':
      return withMessage(state, event.messageId, (m) => ({
        ...m,
        parts: [...m.parts, { kind: 'tool', tool: { ...event.tool } }],
      }));
    case 'tool_execution_update':
    case 'tool_execution_end':
      return withMessage(state, event.messageId, (m) => ({
        ...m,
        parts: m.parts.map((p) =>
          p.kind === 'tool' && p.tool.toolCallId === event.toolCallId
            ? { kind: 'tool', tool: { ...p.tool, ...event.patch } as ToolCallSummary }
            : p,
        ),
      }));
    case 'error':
      return { lastError: event.message };
    default:
      return {};
  }
}

function stateWithRunState(state: AgentState, runState: AgentRunState): AgentState {
  return state.runState === runState ? state : { ...state, runState };
}

function applyEnvelope(
  store: AgentStoreState,
  envelope: AgentEventEnvelope,
): Partial<AgentStoreState> {
  const active = store.activeChatId === envelope.chatId;
  const currentMessages = active ? store.messages : store.messagesByChat[envelope.chatId] ?? [];
  const currentState = active
    ? store.state
    : store.stateByChat[envelope.chatId] ?? { ...INITIAL_STATE };
  const currentRunState = active ? store.runState : currentState.runState;

  const scopedState: AgentStoreState = {
    ...store,
    messages: currentMessages,
    state: currentState,
    runState: currentRunState,
  };
  const patch = applyEvent(scopedState, envelope.event);
  const changed = Object.keys(patch).length > 0;
  if (!changed) return {};

  const nextMessages = patch.messages ?? currentMessages;
  const nextRunState = patch.runState ?? patch.state?.runState ?? currentRunState;
  const nextAgentState = patch.state ?? stateWithRunState(currentState, nextRunState);

  const next: Partial<AgentStoreState> = {
    messagesByChat: { ...store.messagesByChat, [envelope.chatId]: nextMessages },
    stateByChat: { ...store.stateByChat, [envelope.chatId]: nextAgentState },
  };

  if (active) {
    next.messages = nextMessages;
    next.state = nextAgentState;
    next.runState = nextRunState;
    if (patch.lastError !== undefined) next.lastError = patch.lastError;
  }

  return next;
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  state: INITIAL_STATE,
  runState: 'idle',
  activeChatId: null,
  messages: [],
  messagesByChat: {},
  stateByChat: {},
  lastError: null,
  subscribed: false,
  models: [],

  ensureSubscribed() {
    if (get().subscribed) return;
    set({ subscribed: true });
    piClient.subscribeAll((envelope) => {
      set((s) => applyEnvelope(s, envelope));
    });
    // No active chat at startup — getState() rejects until one is opened.
    // loadActiveChat() pulls state + transcript once a chat is selected.
    void piClient.getState().then(
      (state) => set({ state, runState: state.runState }),
      () => {},
    );
  },

  async loadActiveChat(chatId?: string) {
    const targetChatId = chatId ?? get().activeChatId;
    if (targetChatId) {
      const cachedMessages = get().messagesByChat[targetChatId];
      const cachedState = get().stateByChat[targetChatId];
      set({
        activeChatId: targetChatId,
        ...(cachedMessages ? { messages: cachedMessages } : {}),
        ...(cachedState ? { state: cachedState, runState: cachedState.runState } : {}),
      });
    }

    try {
      const [state, messages, models] = await Promise.all([
        piClient.getState(),
        piClient.getMessages(),
        piClient.getAvailableModels(),
      ]);
      set((s) => ({
        activeChatId: targetChatId,
        state,
        runState: state.runState,
        messages,
        models,
        lastError: null,
        ...(targetChatId
          ? {
              messagesByChat: { ...s.messagesByChat, [targetChatId]: messages },
              stateByChat: { ...s.stateByChat, [targetChatId]: state },
            }
          : {}),
      }));
    } catch (err) {
      set({
        activeChatId: targetChatId,
        messages: [],
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async loadModels() {
    try {
      const models = await piClient.getAvailableModels();
      set({ models });
    } catch {
      // No active backend yet — models load on chat open.
    }
  },

  async setModel(provider: string, modelId: string) {
    try {
      await piClient.setModel(provider, modelId);
      const state = await piClient.getState();
      set((s) => ({
        state,
        runState: state.runState,
        ...(s.activeChatId ? { stateByChat: { ...s.stateByChat, [s.activeChatId]: state } } : {}),
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  async setThinkingLevel(level: ThinkingLevel) {
    try {
      await piClient.setThinkingLevel(level);
      const state = await piClient.getState();
      set((s) => ({
        state,
        runState: state.runState,
        ...(s.activeChatId ? { stateByChat: { ...s.stateByChat, [s.activeChatId]: state } } : {}),
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  async sendPrompt(text: string, images: AgentImageContent[] = [], streamingBehavior?: PromptOptions['streamingBehavior']) {
    const trimmed = text.trim();
    if (trimmed.length === 0 && images.length === 0) return;
    // Optimistically append the user message; the backend will broadcast its
    // own message_start, which we suppress as a duplicate by id. During a run,
    // keep queued steering/follow-up messages visually pending until pi's
    // queue_update confirms delivery.
    const parts: MessagePart[] = [];
    if (trimmed.length > 0) parts.push({ kind: 'text', text: trimmed });
    for (const image of images) parts.push({ kind: 'image', image: { ...image } });
    const queueKind = streamingBehavior === 'steer' || streamingBehavior === 'followUp' ? streamingBehavior : null;
    const userMessage: DisplayMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      time: nowHHMM(),
      parts,
      ...(queueKind
        ? { queue: { kind: queueKind, status: 'pending' as const, text: trimmed, createdAt: Date.now() } }
        : {}),
    };
    set((s) => {
      const messages = [...s.messages, userMessage];
      return {
        messages,
        ...(s.activeChatId
          ? { messagesByChat: { ...s.messagesByChat, [s.activeChatId]: messages } }
          : {}),
      };
    });
    try {
      const options: PromptOptions = {};
      if (images.length > 0) options.images = images;
      if (streamingBehavior) options.streamingBehavior = streamingBehavior;
      await piClient.prompt(trimmed, options);
      if (queueKind) {
        set((s) => {
          const messages = s.messages.map((m) =>
            m.id === userMessage.id && m.queue?.status === 'pending'
              ? { ...m, queue: { ...m.queue, status: 'queued' as const } }
              : m,
          );
          return {
            messages,
            ...(s.activeChatId
              ? { messagesByChat: { ...s.messagesByChat, [s.activeChatId]: messages } }
              : {}),
          };
        });
      }
    } catch (err) {
      set((s) => {
        const messages = s.messages.filter((m) => m.id !== userMessage.id);
        return {
          messages,
          lastError: err instanceof Error ? err.message : String(err),
          ...(s.activeChatId
            ? { messagesByChat: { ...s.messagesByChat, [s.activeChatId]: messages } }
            : {}),
        };
      });
    }
  },

  async abort() {
    try {
      await piClient.abort();
    } catch {
      // Swallow — abort during idle is a no-op.
    }
  },

  clearError() {
    set({ lastError: null });
  },

  discardQueuedMessage(messageId: string) {
    set((s) => {
      const messages = s.messages.filter((m) => m.id !== messageId);
      return {
        messages,
        ...(s.activeChatId
          ? { messagesByChat: { ...s.messagesByChat, [s.activeChatId]: messages } }
          : {}),
      };
    });
  },
}));
