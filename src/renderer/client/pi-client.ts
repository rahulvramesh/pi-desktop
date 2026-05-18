import type { PiApi } from '../../shared/ipc.js';

/**
 * Renderer transport boundary. React/stores should talk to `piClient`, not
 * directly to Electron's `window.pi`. A future `HttpPiClient` can implement the
 * same shape against the Rust proxy without changing UI code.
 */
export type PiClient = PiApi;

export const electronPiClient: PiClient = window.pi;

let currentClient: PiClient = electronPiClient;

export function getPiClient(): PiClient {
  return currentClient;
}

export function setPiClient(client: PiClient): void {
  currentClient = client;
}

export const piClient: PiClient = new Proxy({} as PiClient, {
  get(_target, prop: keyof PiClient) {
    return getPiClient()[prop];
  },
});
