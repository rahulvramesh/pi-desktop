/**
 * electron-store backed prefs bridge.
 *
 * Persisted state lives in app.getPath('userData') / 'pi-desktop-prefs.json'.
 * The brief explicitly forbids localStorage; the renderer reads/writes prefs
 * only through `window.pi.prefs.{get,set}`.
 */

import { ipcMain } from 'electron';

import { IPC, PREFS_DEFAULTS, type PrefsShape } from '../shared/ipc.js';

// electron-store is loaded lazily: Electron's bundled Node (v20.18.3) chokes
// while preparsing one of conf's transitive CJS deps at static-import time
// (`cjsPreparseModuleExports` -> "Cannot read properties of undefined").
// Dynamic-importing inside the handler defers it past the preparse step.
type StoreCtor = new <T>(opts?: { name?: string; defaults?: T }) => {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set(key: keyof T | Partial<T>, value?: unknown): void;
};

let store: { store: PrefsShape; get: (k: keyof PrefsShape) => unknown; set: (k: keyof PrefsShape | Partial<PrefsShape>, v?: unknown) => void } | null = null;

async function getStore() {
  if (store) return store;
  const mod = await import('electron-store');
  const Ctor = (mod as unknown as { default: StoreCtor }).default ?? (mod as unknown as StoreCtor);
  store = new Ctor<PrefsShape>({
    name: 'pi-desktop-prefs',
    defaults: PREFS_DEFAULTS,
  });
  return store;
}

export function installPrefsBridge(): void {
  ipcMain.handle(IPC.PrefsGet, async (): Promise<PrefsShape> => {
    const s = await getStore();
    return { ...PREFS_DEFAULTS, ...(s.store as PrefsShape) };
  });
  ipcMain.handle(IPC.PrefsSet, async (_e, patch: Partial<PrefsShape>): Promise<PrefsShape> => {
    const s = await getStore();
    const current = { ...PREFS_DEFAULTS, ...(s.store as PrefsShape) };
    const next = { ...current, ...patch };
    s.set(next);
    return next;
  });
}
