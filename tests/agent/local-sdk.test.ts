import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/agent/backend.js';

// Mock the SDK module before importing LocalSdkBackend so the import chain
// never touches the real network or fs.
const sessionMocks = vi.hoisted(() => ({
  prompt: vi.fn(async (_text: string) => undefined),
  steer: vi.fn(async (_text: string) => undefined),
  followUp: vi.fn(async (_text: string) => undefined),
  abort: vi.fn(async () => undefined),
  setThinkingLevel: vi.fn((_level: string) => undefined),
  dispose: vi.fn(() => undefined),
  subscribers: [] as Array<(event: unknown) => void>,
  subscribe(listener: (event: unknown) => void) {
    sessionMocks.subscribers.push(listener);
    return () => {
      const i = sessionMocks.subscribers.indexOf(listener);
      if (i >= 0) sessionMocks.subscribers.splice(i, 1);
    };
  },
  state: {
    model: undefined,
    errorMessage: undefined,
  },
  sessionId: 'mock-session-id',
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: sessionMocks.prompt,
      steer: sessionMocks.steer,
      followUp: sessionMocks.followUp,
      abort: sessionMocks.abort,
      setThinkingLevel: sessionMocks.setThinkingLevel,
      dispose: sessionMocks.dispose,
      subscribe: sessionMocks.subscribe,
      get state() {
        return sessionMocks.state;
      },
      get sessionId() {
        return sessionMocks.sessionId;
      },
    },
  })),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
  })),
}));

describe('LocalSdkBackend', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    sessionMocks.subscribers.length = 0;
    sessionMocks.prompt.mockClear();
    sessionMocks.steer.mockClear();
    sessionMocks.followUp.mockClear();
    sessionMocks.abort.mockClear();
    sessionMocks.dispose.mockClear();
    originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-FAKE_KEY_FOR_TESTING_12345';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalKey;
  });

  it('routes prompt() to session.prompt and normalizes events', async () => {
    const { LocalSdkBackend } = await import('../../src/agent/local-sdk.js');
    const backend = new LocalSdkBackend({ cwd: '/tmp/pi-test' });
    const events: AgentEvent[] = [];
    backend.subscribe((e) => events.push(e));
    await backend.prompt('hello');
    expect(sessionMocks.prompt).toHaveBeenCalledWith('hello', {});

    // Simulate the SDK emitting a streamed text_delta cycle.
    const listener = sessionMocks.subscribers[0];
    expect(listener).toBeDefined();
    listener!({ type: 'agent_start' });
    listener!({
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 0 },
    });
    listener!({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello!',
        partial: {},
      },
    });
    listener!({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read',
      args: { path: 'src/foo.ts' },
    });
    listener!({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'read',
      result: { content: 'file contents' },
      isError: false,
    });
    listener!({
      type: 'message_end',
      message: { role: 'assistant', content: [], timestamp: 0 },
    });
    listener!({ type: 'agent_end', messages: [] });

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('message_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');
    expect(types).toContain('agent_end');

    const startEv = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_execution_start' }> =>
        e.type === 'tool_execution_start',
    );
    expect(startEv?.tool.name).toBe('read');
    expect(startEv?.tool.arg).toBe('src/foo.ts');

    await backend.dispose();
  });

  it('passes image attachments through to SDK prompt, steer, and followUp', async () => {
    const { LocalSdkBackend } = await import('../../src/agent/local-sdk.js');
    const backend = new LocalSdkBackend({ cwd: '/tmp/pi-test' });
    const image = { type: 'image' as const, data: 'abc123', mimeType: 'image/png', name: 'shot.png' };
    const sdkImage = { type: 'image', data: 'abc123', mimeType: 'image/png' };

    await backend.prompt('look', { images: [image] });
    expect(sessionMocks.prompt).toHaveBeenCalledWith('look', { images: [sdkImage] });

    await backend.steer('steer', [image]);
    expect(sessionMocks.steer).toHaveBeenCalledWith('steer', [sdkImage]);

    await backend.followUp('follow', [image]);
    expect(sessionMocks.followUp).toHaveBeenCalledWith('follow', [sdkImage]);

    await backend.dispose();
  });

  it('emits an error event when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { LocalSdkBackend } = await import('../../src/agent/local-sdk.js');
    const backend = new LocalSdkBackend({ cwd: '/tmp/pi-test' });
    const events: AgentEvent[] = [];
    backend.subscribe((e) => events.push(e));
    await backend.prompt('hello');
    const error = events.find(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/ANTHROPIC_API_KEY/);
    await backend.dispose();
  });

  it('redacts API-key-shaped strings out of error messages', async () => {
    const { LocalSdkBackend } = await import('../../src/agent/local-sdk.js');
    const backend = new LocalSdkBackend({ cwd: '/tmp/pi-test' });
    sessionMocks.prompt.mockRejectedValueOnce(
      new Error('upstream failed for sk-abcdefghijklmnopqrstuv'),
    );
    const events: AgentEvent[] = [];
    backend.subscribe((e) => events.push(e));
    await backend.prompt('hello');
    const error = events.find(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error?.message).toContain('sk-…redacted');
    expect(error?.message).not.toContain('sk-abcdefghijklmnopqrstuv');
    await backend.dispose();
  });

  it('abort delegates to the SDK session', async () => {
    const { LocalSdkBackend } = await import('../../src/agent/local-sdk.js');
    const backend = new LocalSdkBackend({ cwd: '/tmp/pi-test' });
    await backend.abort();
    expect(sessionMocks.abort).toHaveBeenCalled();
    await backend.dispose();
  });
});
