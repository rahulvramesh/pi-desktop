/**
 * UI store — purely visual prefs, persisted via electron-store through IPC.
 * Mirrors the design's tweaks panel: theme, accent, density, sidebar, right
 * pane, and the developer-facing agent-state override.
 */

import { create } from 'zustand';
import { PREFS_DEFAULTS, type PrefsShape } from '../../shared/ipc.js';

interface UiState extends PrefsShape {
  tweaksOpen: boolean;
  /** True until the first hydrate completes — prevents flicker on launch. */
  ready: boolean;

  hydrate(): Promise<void>;
  patch(patch: Partial<PrefsShape>): Promise<void>;
  setTweaksOpen(open: boolean): void;
  toggleTweaks(): void;
  toggleSidebar(): void;
}

function applyTokensToRoot(prefs: PrefsShape): void {
  const root = document.documentElement;
  root.dataset['theme'] = prefs.theme;
  root.dataset['density'] = prefs.density;
  root.style.setProperty('--accent', prefs.accent);
  root.style.setProperty('--accent-2', prefs.accent);
  // Derive soft / edge from the accent the same way the prototype does.
  root.style.setProperty('--accent-soft', `${prefs.accent}1A`);
  root.style.setProperty('--accent-edge', `${prefs.accent}47`);
}

export const useUiStore = create<UiState>((set, get) => ({
  ...PREFS_DEFAULTS,
  tweaksOpen: false,
  ready: false,

  async hydrate() {
    try {
      const prefs = await window.pi.prefs.get();
      applyTokensToRoot(prefs);
      set({ ...prefs, ready: true });
    } catch {
      // First-run or sandboxed test: stay on defaults.
      applyTokensToRoot(PREFS_DEFAULTS);
      set({ ready: true });
    }
  },

  async patch(patch: Partial<PrefsShape>) {
    const optimistic: PrefsShape = {
      theme: get().theme,
      accent: get().accent,
      density: get().density,
      sidebarVisible: get().sidebarVisible,
      rightPane: get().rightPane,
      agentStateOverride: get().agentStateOverride,
      ...patch,
    };
    applyTokensToRoot(optimistic);
    set(optimistic);
    try {
      const next = await window.pi.prefs.set(patch);
      applyTokensToRoot(next);
      set(next);
    } catch {
      // Persistence is best-effort; the in-memory copy is the source of truth
      // for this session.
    }
  },

  setTweaksOpen(open) {
    set({ tweaksOpen: open });
  },
  toggleTweaks() {
    set({ tweaksOpen: !get().tweaksOpen });
  },
  toggleSidebar() {
    void get().patch({ sidebarVisible: !get().sidebarVisible });
  },
}));
