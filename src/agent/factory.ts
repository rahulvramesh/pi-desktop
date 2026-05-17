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
import type { AgentBackend, AgentBackendConfig } from './backend.js';

export function resolveBackendConfig(env: NodeJS.ProcessEnv, cwd: string): AgentBackendConfig {
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
    default:
      throw new Error(`Unknown PI_BACKEND value: ${kind}`);
  }
}

/** Allow overriding the pi command (e.g. an absolute path) via env. */
function piCommand(env: NodeJS.ProcessEnv): string {
  return env.PI_BIN?.trim() || 'pi';
}

export async function createBackend(config: AgentBackendConfig): Promise<AgentBackend> {
  switch (config.kind) {
    case 'mock':
      return new MockBackend();
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
  }
}
