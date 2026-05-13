/**
 * electron-store backed prefs bridge.
 *
 * Persisted state lives in app.getPath('userData') / 'pi-desktop-prefs.json'.
 * The brief explicitly forbids localStorage; the renderer reads/writes prefs
 * only through `window.pi.prefs.{get,set}`.
 */

import { ipcMain } from 'electron';
import ElectronStoreCtor from 'electron-store';

import { IPC, PREFS_DEFAULTS, type PrefsShape } from '../shared/ipc.js';

// electron-store exports a CJS-default class; under ESM bundling this lands as
// { default } or directly as the constructor depending on the bundler. Handle both.
const Store = (
  (ElectronStoreCtor as unknown as { default?: typeof ElectronStoreCtor }).default ??
  ElectronStoreCtor
) as new <T>(opts?: { name?: string; defaults?: T }) => {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set(key: keyof T | Partial<T>, value?: unknown): void;
};

let store: ReturnType<typeof newStore> | null = null;

function newStore() {
  return new Store<PrefsShape>({
    name: 'pi-desktop-prefs',
    defaults: PREFS_DEFAULTS,
  });
}

function getStore() {
  if (!store) store = newStore();
  return store;
}

export function installPrefsBridge(): void {
  ipcMain.handle(IPC.PrefsGet, async (): Promise<PrefsShape> => {
    const s = getStore();
    return { ...PREFS_DEFAULTS, ...(s.store as PrefsShape) };
  });
  ipcMain.handle(IPC.PrefsSet, async (_e, patch: Partial<PrefsShape>): Promise<PrefsShape> => {
    const s = getStore();
    const current = { ...PREFS_DEFAULTS, ...(s.store as PrefsShape) };
    const next = { ...current, ...patch };
    s.set(next);
    return next;
  });
}
