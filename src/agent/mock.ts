/**
 * MockBackend — emits a scripted streamed conversation so the renderer can be
 * developed and tested without any LLM. The conversation arc mirrors the
 * design prototype's level-loader scenario: read a file, then propose an edit.
 *
 * Realism rules:
 *  - text_delta chunks land every ~25ms in word-shaped fragments
 *  - tool_execution_start fires before any preview text
 *  - tool_execution_end carries the full preview
 *  - abort() cancels in-flight timers immediately
 */

import type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentState,
  PromptOptions,
  ThinkingLevel,
  ToolCallSummary,
} from './backend.js';

interface ScriptedStep {
  /** Delay before this step fires, in ms (additive to previous step). */
  after: number;
  emit: (ctx: ScriptContext) => AgentEvent | AgentEvent[] | null;
}

interface ScriptContext {
  messageId: string;
  /** Allocate a stable toolCallId scoped to the current run. */
  toolCallId: (slot: number) => string;
}

const FALLBACK_REPLY =
  "I'd start by reading the relevant files and looking at how the affected " +
  'functions are called. Once I know the shape of the data, the fix is usually a small one.';

/**
 * Tokenize text into streaming-shaped fragments (keep whitespace attached to
 * the previous chunk so concatenation is exact). Roughly 4–8 chars per chunk.
 */
function chunkText(text: string): string[] {
  return text.match(/.{1,8}(\s|$)|\S+/g) ?? [text];
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Build the scripted run that responds to any user prompt. */
function buildScript(
  userText: string,
  ctx: ScriptContext,
): ScriptedStep[] {
  const introOpening =
    userText.length > 0
      ? "Looking at the level loader. I'll start by reading the current implementation and the on-disk format spec."
      : FALLBACK_REPLY;

  const closing =
    '\n\nFound it. The Parser already detects v2 and returns a `{ chunks }` shape, but `Loader.load` ' +
    'unconditionally reaches for `.tiles` — which does not exist on v2 outputs. Patching `Loader.ts` ' +
    'now and adding a regression test.';

  const introChunks = chunkText(introOpening);
  const closingChunks = chunkText(closing);

  const toolRead: ToolCallSummary = {
    toolCallId: ctx.toolCallId(0),
    name: 'read',
    arg: 'src/levels/Loader.ts',
    status: 'running',
  };
  const toolEdit: ToolCallSummary = {
    toolCallId: ctx.toolCallId(1),
    name: 'edit',
    arg: 'src/levels/Loader.ts',
    status: 'running',
  };

  const readPreview =
    '  1  import { Parser } from "./Parser";\n' +
    '  2  import { LevelSchema } from "./schema";\n' +
    '  3\n' +
    '  4  export class Loader {\n' +
    '  5    async load(path: string) {\n' +
    '  6      const buf = await Bun.file(path).arrayBuffer();\n' +
    '  7      const parsed = Parser.parse(buf);\n' +
    '  8      return parsed.tiles;     // <- v1-only\n' +
    '  9    }\n' +
    ' 10  }';

  const editPreview =
    '  async load(path: string) {\n' +
    '    const buf = await Bun.file(path).arrayBuffer();\n' +
    '    const parsed = Parser.parse(buf);\n' +
    '-   return parsed.tiles;\n' +
    '+   if (isV2(parsed)) {\n' +
    '+     const tilesBuf = parsed.chunks.get("TILES");\n' +
    '+     if (!tilesBuf) throw new Error("v2 level missing TILES chunk");\n' +
    '+     return decodeTiles(tilesBuf);\n' +
    '+   }\n' +
    '+   return { tiles: parsed.tiles, meta: parsed.meta };\n' +
    '  }';

  const steps: ScriptedStep[] = [];

  // Opening message
  steps.push({
    after: 0,
    emit: () => ({
      type: 'message_start',
      message: {
        id: ctx.messageId,
        role: 'assistant',
        time: nowHHMM(),
        text: '',
        toolCalls: [],
      },
    }),
  });

  for (const piece of introChunks) {
    steps.push({
      after: 25,
      emit: ({ messageId }) => ({
        type: 'text_delta',
        messageId,
        delta: piece,
      }),
    });
  }

  // Tool 1: read
  steps.push({
    after: 180,
    emit: ({ messageId }) => ({
      type: 'tool_execution_start',
      messageId,
      tool: toolRead,
    }),
  });
  steps.push({
    after: 420,
    emit: ({ messageId }) => ({
      type: 'tool_execution_end',
      messageId,
      toolCallId: toolRead.toolCallId,
      patch: {
        status: 'ok',
        durationSeconds: 0.4,
        preview: readPreview,
      },
    }),
  });

  // Tool 2: edit
  steps.push({
    after: 200,
    emit: ({ messageId }) => ({
      type: 'tool_execution_start',
      messageId,
      tool: toolEdit,
    }),
  });
  steps.push({
    after: 520,
    emit: ({ messageId }) => ({
      type: 'tool_execution_end',
      messageId,
      toolCallId: toolEdit.toolCallId,
      patch: {
        status: 'ok',
        durationSeconds: 0.5,
        preview: editPreview,
        stats: { add: 6, del: 1 },
      },
    }),
  });

  // Closing text
  for (const piece of closingChunks) {
    steps.push({
      after: 22,
      emit: ({ messageId }) => ({
        type: 'text_delta',
        messageId,
        delta: piece,
      }),
    });
  }

  steps.push({
    after: 80,
    emit: ({ messageId }) => ({ type: 'message_end', messageId }),
  });

  return steps;
}

export interface MockBackendOptions {
  /** Multiplier for delays. Tests pass a small value to keep wallclock low. */
  speed?: number;
}

export class MockBackend implements AgentBackend {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly messages: AgentMessage[] = [];
  private state: AgentState = {
    runState: 'idle',
    modelProvider: 'mock',
    modelId: 'mock-sonnet',
    thinkingLevel: 'medium',
    tokensUsed: 0,
    tokensMax: 200_000,
    sessionId: `mock-${Date.now()}`,
  };
  private currentTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAbort: AbortController | null = null;
  private readonly speed: number;

  constructor(options: MockBackendOptions = {}) {
    this.speed = options.speed ?? 1;
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
        // Listener errors are isolated; a broken renderer should not break the backend.
      }
    }
  }

  private setRunState(runState: AgentState['runState']): void {
    this.state = { ...this.state, runState };
    this.emit({ type: 'state_changed', state: this.state });
  }

  async prompt(text: string, _options?: PromptOptions): Promise<void> {
    if (this.currentAbort) {
      // A prompt() while running becomes an implicit steer (matches SDK semantics).
      return this.steer(text);
    }

    const userMessage: AgentMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      time: nowHHMM(),
      text,
      toolCalls: [],
    };
    this.messages.push(userMessage);
    this.emit({ type: 'message_start', message: userMessage });
    this.emit({ type: 'message_end', messageId: userMessage.id });

    this.emit({ type: 'agent_start' });
    this.setRunState('thinking');

    const abort = new AbortController();
    this.currentAbort = abort;

    const assistantId = `a-${Date.now()}`;
    const ctx: ScriptContext = {
      messageId: assistantId,
      toolCallId: (slot) => `${assistantId}-tool-${slot}`,
    };

    const script = buildScript(text, ctx);
    let stepIndex = 0;

    return new Promise<void>((resolve) => {
      const runNext = (): void => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        const step = script[stepIndex++];
        if (!step) {
          this.setRunState('idle');
          this.emit({ type: 'agent_end' });
          this.currentAbort = null;
          this.currentTimer = null;
          resolve();
          return;
        }
        this.currentTimer = setTimeout(() => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          // Transition idle→thinking→running when the first tool fires.
          if (this.state.runState === 'thinking') {
            const next = step.emit(ctx);
            const events = next === null ? [] : Array.isArray(next) ? next : [next];
            if (events.some((e) => e.type === 'tool_execution_start')) {
              this.setRunState('running');
            }
            for (const e of events) {
              this.applyToHistory(e);
              this.emit(e);
            }
          } else {
            const next = step.emit(ctx);
            const events = next === null ? [] : Array.isArray(next) ? next : [next];
            for (const e of events) {
              this.applyToHistory(e);
              this.emit(e);
            }
          }
          runNext();
        }, Math.max(1, Math.round(step.after * this.speed)));
      };
      runNext();
    });
  }

  private applyToHistory(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role !== 'user') {
          this.messages.push({ ...event.message, toolCalls: [...event.message.toolCalls] });
        }
        return;
      case 'text_delta': {
        const msg = this.messages.find((m) => m.id === event.messageId);
        if (msg) msg.text += event.delta;
        return;
      }
      case 'tool_execution_start': {
        const msg = this.messages.find((m) => m.id === event.messageId);
        if (msg) msg.toolCalls.push({ ...event.tool });
        return;
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const msg = this.messages.find((m) => m.id === event.messageId);
        if (!msg) return;
        const tool = msg.toolCalls.find((t) => t.toolCallId === event.toolCallId);
        if (tool) Object.assign(tool, event.patch);
        return;
      }
      default:
        return;
    }
  }

  async steer(text: string): Promise<void> {
    // For the mock, a steer is just an inline user message + cancel + restart
    // would be heavy; treat it as a queued follow-up event for observability.
    this.emit({ type: 'agent_start' }); // no-op signal so listeners can react
    this.emit({ type: 'error', message: `mock backend: steer queued — "${text.slice(0, 60)}"` });
  }

  async followUp(text: string): Promise<void> {
    return this.steer(text);
  }

  async abort(): Promise<void> {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.setRunState('idle');
    this.emit({ type: 'agent_end' });
  }

  async getState(): Promise<AgentState> {
    return this.state;
  }

  async getMessages(): Promise<AgentMessage[]> {
    return this.messages.map((m) => ({ ...m, toolCalls: [...m.toolCalls] }));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.state = { ...this.state, modelProvider: provider, modelId };
    this.emit({ type: 'state_changed', state: this.state });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.state = { ...this.state, thinkingLevel: level };
    this.emit({ type: 'state_changed', state: this.state });
  }

  async newSession(): Promise<void> {
    this.messages.length = 0;
    this.state = { ...this.state, sessionId: `mock-${Date.now()}`, tokensUsed: 0 };
    this.emit({ type: 'state_changed', state: this.state });
  }

  async switchSession(_path: string): Promise<void> {
    // Mock backend has no on-disk sessions; satisfy the contract silently.
    return;
  }

  async fork(_entryId: string): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    await this.abort();
    this.listeners.clear();
  }
}
