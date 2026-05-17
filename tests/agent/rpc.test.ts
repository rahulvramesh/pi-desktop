import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RpcLogEntry } from '../../src/agent/backend.js';

type Handler = (...args: unknown[]) => void;

const childProcessMocks = vi.hoisted(() => {
  class MiniEmitter {
    private readonly handlers = new Map<string, Handler[]>();

    on(event: string, handler: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  interface FakeChild {
    stdin: {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: MiniEmitter;
    stderr: MiniEmitter;
    on: (event: string, handler: Handler) => FakeChild;
    emit: (event: string, ...args: unknown[]) => void;
    kill: ReturnType<typeof vi.fn>;
  }

  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const emitter = new MiniEmitter();
    const child: FakeChild = {
      stdin: {
        write: vi.fn(() => true),
        end: vi.fn(),
      },
      stdout: new MiniEmitter(),
      stderr: new MiniEmitter(),
      on(event: string, handler: Handler) {
        emitter.on(event, handler);
        return child;
      },
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      kill: vi.fn(() => true),
    };
    children.push(child);
    return child;
  });

  return { spawn, children };
});

vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}));

describe('RpcBackend RPC trace logging', () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockClear();
    childProcessMocks.children.length = 0;
  });

  it('logs redacted requests and paired responses with timing metadata', async () => {
    const { RpcBackend } = await import('../../src/agent/rpc.js');
    const backend = new RpcBackend({
      spawn: { command: 'pi', args: ['--mode', 'rpc'] },
      cwd: process.cwd(),
    });
    const logs: RpcLogEntry[] = [];
    backend.subscribeRpcLogs((entry) => logs.push(entry));

    const imageData = 'abc123'.repeat(2_000);
    const promptPromise = backend.prompt('hello sk-abcdefghijklmnopqrstuv', {
      images: [{ type: 'image', data: imageData, mimeType: 'image/png', name: 'shot.png' }],
    });
    await vi.waitFor(() => expect(childProcessMocks.children[0]?.stdin.write).toHaveBeenCalledTimes(1));

    const written = JSON.parse(String(childProcessMocks.children[0]!.stdin.write.mock.calls[0]?.[0]));
    expect(written.images).toEqual([{ type: 'image', data: imageData, mimeType: 'image/png' }]);

    const request = logs.find((entry) => entry.direction === 'request');
    expect(request).toBeDefined();
    expect(request?.method).toBe('prompt');
    expect(request?.requestId).toBe('r-1');
    expect(request?.raw).toContain('sk-…redacted');
    expect(request?.raw).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(request?.raw).not.toContain(imageData);
    expect((request?.payload as { message?: string }).message).toContain('sk-…redacted');
    expect(
      (((request?.payload as { images?: Array<{ data?: string }> }).images ?? [])[0]?.data ?? ''),
    ).toContain('base64 image omitted');

    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'response',
          id: 'r-1',
          success: true,
          data: {
            apiKey: 'plain-secret-value',
            authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
            echoed: 'ok',
          },
        })}\n`,
      ),
    );
    await promptPromise;

    const response = logs.find((entry) => entry.direction === 'response');
    expect(response).toBeDefined();
    expect(response?.requestId).toBe('r-1');
    expect(response?.method).toBe('prompt');
    expect(response?.success).toBe(true);
    expect(response?.durationMs).toEqual(expect.any(Number));
    expect(response?.raw).not.toContain('plain-secret-value');
    expect(response?.raw).not.toContain('abcdefghijklmnopqrstuvwxyz');
    const responsePayload = response?.payload as { data?: { apiKey?: string; authorization?: string } };
    expect(responsePayload.data?.apiKey).toBe('…redacted');
    expect(responsePayload.data?.authorization).toBe('…redacted');

    await backend.dispose();
  });

  it('logs RPC events, non-JSON stdout, and stderr', async () => {
    const { RpcBackend } = await import('../../src/agent/rpc.js');
    const backend = new RpcBackend({
      spawn: { command: 'pi', args: ['--mode', 'rpc'] },
      cwd: process.cwd(),
    });
    const logs: RpcLogEntry[] = [];
    backend.subscribeRpcLogs((entry) => logs.push(entry));

    const promptPromise = backend.prompt('hello');
    await vi.waitFor(() => expect(childProcessMocks.children[0]?.stdin.write).toHaveBeenCalledTimes(1));

    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'agent_start' })}\nnot-json noise\n`),
    );
    childProcessMocks.children[0]!.stderr.emit('data', Buffer.from('warning sk-abcdefghijklmnopqrstuv'));
    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'response', id: 'r-1', success: true, data: {} })}\n`),
    );
    await promptPromise;

    expect(logs.some((entry) => entry.direction === 'event' && entry.method === 'agent_start')).toBe(true);
    expect(logs.some((entry) => entry.direction === 'stdout' && entry.raw.includes('not-json noise'))).toBe(true);
    const stderr = logs.find((entry) => entry.direction === 'stderr');
    expect(stderr?.raw).toContain('sk-…redacted');
    expect(stderr?.raw).not.toContain('sk-abcdefghijklmnopqrstuv');

    await backend.dispose();
  });
});

describe('RpcBackend startup reads', () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockClear();
    childProcessMocks.children.length = 0;
  });

  it('starts the RPC process when state is requested before the first prompt', async () => {
    const { RpcBackend } = await import('../../src/agent/rpc.js');
    const backend = new RpcBackend({
      spawn: { command: 'pi', args: ['--mode', 'rpc'] },
      cwd: process.cwd(),
    });

    const statePromise = backend.getState();
    await vi.waitFor(() => expect(childProcessMocks.children[0]?.stdin.write).toHaveBeenCalledTimes(1));

    expect(childProcessMocks.children[0]!.stdin.write.mock.calls[0]?.[0]).toContain(
      '"type":"get_state"',
    );

    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'response',
          id: 'r-1',
          success: true,
          data: {
            model: {
              provider: 'anthropic',
              id: 'claude-sonnet-4-6',
              contextWindow: 1_000_000,
            },
            thinkingLevel: 'high',
            sessionId: 'session-1',
            autoCompactionEnabled: true,
          },
        })}\n`,
      ),
    );

    await vi.waitFor(() => expect(childProcessMocks.children[0]?.stdin.write).toHaveBeenCalledTimes(2));
    expect(childProcessMocks.children[0]!.stdin.write.mock.calls[1]?.[0]).toContain(
      '"type":"get_session_stats"',
    );
    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'response',
          id: 'r-2',
          success: true,
          data: {
            tokens: { input: 1200, output: 330, cacheRead: 9900, cacheWrite: 12, total: 11442 },
            cost: 0.1234,
            contextUsage: { tokens: 272000, contextWindow: 1_000_000, percent: 27.2 },
          },
        })}\n`,
      ),
    );

    await expect(statePromise).resolves.toMatchObject({
      modelProvider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
      tokensUsed: 272_000,
      tokensMax: 1_000_000,
      tokenUsage: { input: 1200, output: 330, cacheRead: 9900, cacheWrite: 12, total: 11442 },
      costUsd: 0.1234,
      contextPercent: 27.2,
      autoCompactionEnabled: true,
      sessionId: 'session-1',
    });

    await backend.dispose();
  });

  it('starts the RPC process when available models are requested before the first prompt', async () => {
    const { RpcBackend } = await import('../../src/agent/rpc.js');
    const backend = new RpcBackend({
      spawn: { command: 'pi', args: ['--mode', 'rpc'] },
      cwd: process.cwd(),
    });

    const modelsPromise = backend.getAvailableModels();
    await vi.waitFor(() => expect(childProcessMocks.children[0]?.stdin.write).toHaveBeenCalledTimes(1));

    expect(childProcessMocks.children[0]!.stdin.write.mock.calls[0]?.[0]).toContain(
      '"type":"get_available_models"',
    );

    childProcessMocks.children[0]!.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'response',
          id: 'r-1',
          success: true,
          data: {
            models: [
              {
                provider: 'anthropic',
                id: 'claude-sonnet-4-6',
                name: 'Claude Sonnet 4.6',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 1_000_000,
              },
            ],
          },
        })}\n`,
      ),
    );

    await expect(modelsPromise).resolves.toEqual([
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
      },
    ]);

    await backend.dispose();
  });
});
