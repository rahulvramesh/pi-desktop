/**
 * Factory dispatch. Reads PI_BACKEND from the environment:
 *   rpc-local  (default) — RpcBackend driving the user's installed `pi --mode rpc`
 *   mock                 — MockBackend (scripted; used by tests / offline UI work)
 *   sdk-local            — LocalSdkBackend, bundled SDK, env-only API key
 *   rpc-ssh              — RpcBackend over `ssh <host> pi --mode rpc`
 *
 * Default is `rpc-local`: the desktop app reuses whatever pi the user already
 * installed and authenticated, rather than embedding a second agent.
 */

import { MockBackend } from './mock.js';
import { ensureRuntimeProxy } from './proxy-process.js';
import type { AgentBackend, AgentBackendConfig } from './backend.js';

export interface BackendRuntimeContext {
  chatId: string;
  projectId: string;
  title?: string;
}

export function resolveBackendConfig(
  env: NodeJS.ProcessEnv,
  cwd: string,
  context?: BackendRuntimeContext,
): AgentBackendConfig {
  const kind = (env.PI_BACKEND ?? 'rpc-local').trim();
  switch (kind) {
    case 'mock':
      return { kind: 'mock' };
    case 'sdk-local':
      return { kind: 'sdk-local', cwd };
    case 'rpc-local':
      return { kind: 'rpc-local', cwd };
    case 'rpc-ssh': {
      const host = env.PI_RPC_HOST?.trim();
      if (!host) {
        throw new Error('PI_BACKEND=rpc-ssh requires PI_RPC_HOST');
      }
      return { kind: 'rpc-ssh', host, cwd };
    }
    case 'proxy': {
      if (!context) throw new Error('PI_BACKEND=proxy requires a chat runtime context');
      return { kind: 'proxy', cwd, ...context };
    }
    default:
      throw new Error(`Unknown PI_BACKEND value: ${kind}`);
  }
}

/** Allow overriding the pi command (e.g. an absolute path) via env. */
function piCommand(env: NodeJS.ProcessEnv): string {
  return env.PI_BIN?.trim() || 'pi';
}

function mockSpeed(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.PI_MOCK_SPEED?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function createBackend(config: AgentBackendConfig): Promise<AgentBackend> {
  switch (config.kind) {
    case 'mock':
      return new MockBackend({ speed: mockSpeed(process.env) });
    case 'sdk-local': {
      const { LocalSdkBackend } = await import('./local-sdk.js');
      return new LocalSdkBackend({ cwd: config.cwd });
    }
    case 'rpc-local': {
      const { RpcBackend } = await import('./rpc.js');
      return new RpcBackend({
        spawn: { command: piCommand(process.env), args: ['--mode', 'rpc'] },
        cwd: config.cwd,
      });
    }
    case 'rpc-ssh': {
      const { RpcBackend } = await import('./rpc.js');
      return new RpcBackend({
        spawn: {
          command: 'ssh',
          args: [config.host, piCommand(process.env), '--mode', 'rpc'],
        },
        cwd: config.cwd,
      });
    }
    case 'proxy': {
      const [{ ProxyBackend }, connection] = await Promise.all([
        import('./proxy.js'),
        ensureRuntimeProxy(),
      ]);
      return new ProxyBackend({
        ...connection,
        chatId: config.chatId,
        projectId: config.projectId,
        cwd: config.cwd,
        title: config.title,
      });
    }
  }
}
