/**
 * Agent store — chat messages + run state + tool cards.
 *
 * Subscribes to window.pi.subscribe on first read. Streamed text_delta events
 * are appended directly to the matching assistant message; tool_execution_*
 * events mutate the per-message toolCalls array.
 *
 * The renderer is the source of truth for displayed chat history; the main
 * process replays its own state on reload via getMessages() (used by the
 * MockBackend; LocalSdkBackend defers this to later phases).
 */

import { create } from 'zustand';
import type {
  AgentEvent,
  AgentMessage,
  AgentRunState,
  AgentState,
  ToolCallSummary,
} from '../../agent/backend.js';

interface AgentStoreState {
  /** Latest snapshot of agent state (model, tokens, runState). */
  state: AgentState;
  /** Whether the agent is currently streaming a response. */
  runState: AgentRunState;
  /** Ordered chat transcript. */
  messages: AgentMessage[];
  /** Non-fatal info/error banner; consumed by chat composer footer. */
  lastError: string | null;
  /** True once subscribe() has been wired. */
  subscribed: boolean;

  ensureSubscribed(): void;
  sendPrompt(text: string): Promise<void>;
  abort(): Promise<void>;
  clearError(): void;
}

const INITIAL_STATE: AgentState = {
  runState: 'idle',
  modelProvider: 'mock',
  modelId: 'mock-sonnet',
  thinkingLevel: 'medium',
  tokensUsed: 0,
  tokensMax: 200_000,
  sessionId: 'pending',
};

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function applyEvent(state: AgentStoreState, event: AgentEvent): Partial<AgentStoreState> {
  switch (event.type) {
    case 'agent_start':
      return { runState: 'thinking' };
    case 'agent_end':
      return { runState: 'idle' };
    case 'state_changed':
      return { state: event.state, runState: event.state.runState };
    case 'message_start': {
      // Avoid double-inserting if the renderer also pushed the user message.
      const exists = state.messages.some((m) => m.id === event.message.id);
      if (exists) return {};
      return {
        messages: [
          ...state.messages,
          { ...event.message, toolCalls: [...event.message.toolCalls] },
        ],
      };
    }
    case 'text_delta': {
      const idx = state.messages.findIndex((m) => m.id === event.messageId);
      if (idx < 0) return {};
      const next = state.messages.slice();
      const existing = next[idx];
      if (!existing) return {};
      next[idx] = { ...existing, text: existing.text + event.delta };
      return { messages: next };
    }
    case 'message_end':
      return {};
    case 'tool_execution_start': {
      const idx = state.messages.findIndex((m) => m.id === event.messageId);
      if (idx < 0) return {};
      const next = state.messages.slice();
      const msg = next[idx];
      if (!msg) return {};
      next[idx] = { ...msg, toolCalls: [...msg.toolCalls, { ...event.tool }] };
      return { messages: next };
    }
    case 'tool_execution_update':
    case 'tool_execution_end': {
      const idx = state.messages.findIndex((m) => m.id === event.messageId);
      if (idx < 0) return {};
      const next = state.messages.slice();
      const msg = next[idx];
      if (!msg) return {};
      const toolIdx = msg.toolCalls.findIndex((t) => t.toolCallId === event.toolCallId);
      if (toolIdx < 0) return {};
      const tools = msg.toolCalls.slice();
      const tool = tools[toolIdx];
      if (!tool) return {};
      tools[toolIdx] = { ...tool, ...event.patch } as ToolCallSummary;
      next[idx] = { ...msg, toolCalls: tools };
      return { messages: next };
    }
    case 'error':
      return { lastError: event.message };
    default:
      return {};
  }
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  state: INITIAL_STATE,
  runState: 'idle',
  messages: [],
  lastError: null,
  subscribed: false,

  ensureSubscribed() {
    if (get().subscribed) return;
    set({ subscribed: true });
    window.pi.subscribe((event) => {
      set((s) => applyEvent(s, event));
    });
    // Pull initial state and history once.
    void window.pi.getState().then((state) => set({ state, runState: state.runState }));
    void window.pi.getMessages().then((messages) => {
      if (messages.length > 0) set({ messages });
    });
  },

  async sendPrompt(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Optimistically append the user message; the backend will broadcast its
    // own message_start, which we suppress as a duplicate by id.
    const userMessage: AgentMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      time: nowHHMM(),
      text: trimmed,
      toolCalls: [],
    };
    set((s) => ({ messages: [...s.messages, userMessage] }));
    try {
      await window.pi.prompt(trimmed);
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  async abort() {
    try {
      await window.pi.abort();
    } catch {
      // Swallow — abort during idle is a no-op.
    }
  },

  clearError() {
    set({ lastError: null });
  },
}));
