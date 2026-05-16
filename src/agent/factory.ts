/**
 * Factory dispatch. Reads PI_BACKEND from the environment:
 *   mock       (default) — MockBackend
 *   sdk-local            — LocalSdkBackend, Claude Sonnet via env-only API key
 *   rpc-local            — reserved for P6, throws today
 *   rpc-ssh              — reserved for P7, throws today
 */

import { MockBackend } from './mock.js';
import type { AgentBackend, AgentBackendConfig } from './backend.js';

export function resolveBackendConfig(env: NodeJS.ProcessEnv, cwd: string): AgentBackendConfig {
  const kind = (env.PI_BACKEND ?? 'mock').trim();
  switch (kind) {
    case 'mock':
      return { kind: 'mock' };
    case 'sdk-local':
      return { kind: 'sdk-local', cwd };
    case 'rpc-local':
      return { kind: 'rpc-local' };
    case 'rpc-ssh': {
      const host = env.PI_RPC_HOST?.trim();
      if (!host) {
        throw new Error('PI_BACKEND=rpc-ssh requires PI_RPC_HOST');
      }
      return { kind: 'rpc-ssh', host };
    }
    default:
      throw new Error(`Unknown PI_BACKEND value: ${kind}`);
  }
}

export async function createBackend(config: AgentBackendConfig): Promise<AgentBackend> {
  switch (config.kind) {
    case 'mock':
      return new MockBackend();
    case 'sdk-local': {
      const { LocalSdkBackend } = await import('./local-sdk.js');
      return new LocalSdkBackend({ cwd: config.cwd });
    }
    case 'rpc-local':
    case 'rpc-ssh':
      throw new Error(`RPC backends are deferred to phases 6–7; got ${config.kind}`);
  }
}
