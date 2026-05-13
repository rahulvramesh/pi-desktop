import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../../src/agent/mock.js';
import type { AgentEvent } from '../../src/agent/backend.js';

describe('MockBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a streamed conversation with read + edit tool cards', async () => {
    const backend = new MockBackend({ speed: 0.01 });
    const events: AgentEvent[] = [];
    backend.subscribe((e) => events.push(e));

    const run = backend.prompt('look at the level loader');
    await vi.runAllTimersAsync();
    await run;

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');
    expect(types).toContain('message_start');
    expect(types).toContain('message_end');

    const tools = events
      .filter((e): e is Extract<AgentEvent, { type: 'tool_execution_start' }> =>
        e.type === 'tool_execution_start',
      )
      .map((e) => e.tool.name);
    expect(tools).toEqual(['read', 'edit']);

    // Every started tool ends.
    const startedIds = new Set(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'tool_execution_start' }> =>
          e.type === 'tool_execution_start',
        )
        .map((e) => e.tool.toolCallId),
    );
    const endedIds = new Set(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'tool_execution_end' }> =>
          e.type === 'tool_execution_end',
        )
        .map((e) => e.toolCallId),
    );
    for (const id of startedIds) expect(endedIds.has(id)).toBe(true);

    // text_delta events fire and reconstruct into the assistant message text.
    const deltas = events.filter(
      (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(deltas.length).toBeGreaterThan(8);
    const reconstructed = deltas.map((e) => e.delta).join('');
    expect(reconstructed.length).toBeGreaterThan(40);
  });

  it('returns idle agent state after run ends', async () => {
    const backend = new MockBackend({ speed: 0.005 });
    const run = backend.prompt('hi');
    await vi.runAllTimersAsync();
    await run;
    const state = await backend.getState();
    expect(state.runState).toBe('idle');
  });

  it('abort cancels in-flight stream and ends idle', async () => {
    const backend = new MockBackend({ speed: 5 }); // slow so abort hits mid-run
    const events: AgentEvent[] = [];
    backend.subscribe((e) => events.push(e));

    const run = backend.prompt('refactor it');
    // Advance a bit so the run has started but is not done.
    await vi.advanceTimersByTimeAsync(60);
    await backend.abort();
    await vi.runAllTimersAsync();
    await run;

    const last = events[events.length - 1];
    expect(last?.type === 'agent_end' || last?.type === 'state_changed').toBe(true);
    const state = await backend.getState();
    expect(state.runState).toBe('idle');
  });

  it('dispose clears listeners and is idempotent', async () => {
    const backend = new MockBackend({ speed: 0.01 });
    let count = 0;
    const unsubscribe = backend.subscribe(() => count++);
    unsubscribe();
    await backend.dispose();
    await backend.dispose(); // second call should not throw
    // A late subscriber added after dispose should still work mechanically,
    // but no events fire until something calls prompt() again.
    const run = backend.prompt('after dispose');
    await vi.runAllTimersAsync();
    await run;
    // The unsubscribed listener saw nothing because it was removed before any
    // events fired.
    expect(count).toBe(0);
  });

  it('newSession clears history and resets state', async () => {
    const backend = new MockBackend({ speed: 0.005 });
    const run = backend.prompt('first');
    await vi.runAllTimersAsync();
    await run;
    expect((await backend.getMessages()).length).toBeGreaterThan(0);

    await backend.newSession();
    expect((await backend.getMessages()).length).toBe(0);
  });
});
