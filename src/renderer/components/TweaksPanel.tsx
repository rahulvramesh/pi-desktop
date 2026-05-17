import { useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useUiStore } from '../stores/ui.js';
import { useAgentStore } from '../stores/agent.js';
import type { PrefsShape } from '../../shared/ipc.js';
import styles from './TweaksPanel.module.css';

const ACCENTS: string[] = ['#c84a1f', '#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0', '#0a0a0a'];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.lbl}>{label}</div>
      <div className={styles.seg}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`${styles.segBtn} ${value === o ? styles.segBtnActive : ''}`}
            onClick={() => onChange(o)}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatches({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.lbl}>{label}</div>
      <div className={styles.swatches}>
        {ACCENTS.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.swatch} ${value.toLowerCase() === c.toLowerCase() ? styles.swatchOn : ''}`}
            style={{ background: c }}
            aria-label={`Accent ${c}`}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Floating tweaks panel.
 *
 * The brief calls for theme, density, and an agent-state debug toggle. We
 * also wire accent (uniform with the design prototype) and the right-pane
 * picker since those are pure-CSS shifts that cost nothing once tokens are in
 * place. Persisted via electron-store through `window.pi.prefs`.
 */
export function TweaksPanel() {
  const open = useUiStore((s) => s.tweaksOpen);
  const setOpen = useUiStore((s) => s.setTweaksOpen);
  const toggleTweaks = useUiStore((s) => s.toggleTweaks);
  const theme = useUiStore((s) => s.theme);
  const density = useUiStore((s) => s.density);
  const accent = useUiStore((s) => s.accent);
  const rightPane = useUiStore((s) => s.rightPane);
  const devMode = useUiStore((s) => s.devMode);
  const agentStateOverride = useUiStore((s) => s.agentStateOverride);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const patch = useUiStore((s) => s.patch);
  const setRunState = useAgentStore.setState;
  const runStateLive = useAgentStore((s) => s.runState);

  // Alt+T toggles the panel (the brief lists this as the shortcut). Also
  // accepts ⌘K as a stub for the command palette overlay (out of scope).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        toggleTweaks();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, toggleTweaks]);

  // Apply the agent-state override locally: writing into the agent store. This
  // does not call the backend — it's purely a UI debug aid.
  const applyAgentState = (v: PrefsShape['agentStateOverride']) => {
    void patch({ agentStateOverride: v });
    if (v === 'auto') return;
    const next = v === 'idle' ? 'idle' : v === 'thinking' ? 'thinking' : 'running';
    setRunState({ runState: next });
  };

  const toggleDevMode = () => {
    const next = !devMode;
    const nextPatch: Partial<PrefsShape> = { devMode: next };
    if (next) nextPatch.rightPane = 'rpc';
    else if (rightPane === 'rpc') nextPatch.rightPane = 'files';
    void patch(nextPatch);
  };

  const rightPaneOptions: readonly PrefsShape['rightPane'][] = devMode
    ? ['none', 'files', 'diff', 'term', 'preview', 'rpc']
    : ['none', 'files', 'diff', 'term', 'preview'];

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
        <Dialog.Portal>
          <Dialog.Content
            className={styles.panel}
            // Prevent Radix from stealing focus and locking the page.
            onOpenAutoFocus={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => {
              // Keep the panel mounted when clicking elsewhere — it's a
              // floating utility, not a modal.
              e.preventDefault();
            }}
          >
            <div className={styles.head}>
              <Dialog.Title className={styles.title}>Tweaks</Dialog.Title>
              <Dialog.Description className={styles.srOnly}>
                Theme, density, dev mode, and agent-state debug toggles.
              </Dialog.Description>
              <Dialog.Close asChild>
                <button className={styles.close} aria-label="Close">
                  <X size={14} />
                </button>
              </Dialog.Close>
            </div>
            <div className={styles.body}>
              <div className={styles.section}>Theme</div>
              <Segmented
                label="Mode"
                value={theme}
                options={['light', 'dark'] as const}
                onChange={(v) => void patch({ theme: v })}
              />
              <Swatches label="Accent" value={accent} onChange={(v) => void patch({ accent: v })} />

              <div className={styles.section}>Layout</div>
              <Segmented
                label="Density"
                value={density}
                options={['compact', 'regular', 'comfy'] as const}
                onChange={(v) => void patch({ density: v })}
              />
              <div className={styles.row}>
                <div className={styles.lbl}>Sidebar</div>
                <button
                  className={`${styles.toggle} ${sidebarVisible ? styles.toggleOn : ''}`}
                  onClick={() => void patch({ sidebarVisible: !sidebarVisible })}
                  aria-pressed={sidebarVisible}
                  type="button"
                >
                  <span />
                </button>
              </div>
              <Segmented<PrefsShape['rightPane']>
                label="Right pane"
                value={rightPane}
                options={rightPaneOptions}
                onChange={(v) => void patch({ rightPane: v })}
              />

              <div className={styles.section}>Developer</div>
              <div className={styles.row}>
                <div className={styles.lbl}>Dev mode</div>
                <button
                  className={`${styles.toggle} ${devMode ? styles.toggleOn : ''}`}
                  onClick={toggleDevMode}
                  aria-pressed={devMode}
                  type="button"
                >
                  <span />
                </button>
              </div>
              <div className={styles.note}>
                Shows a live <code>RPC</code> tab with JSONL requests, responses, events, and
                stderr. API-key shaped strings are redacted.
              </div>

              <div className={styles.section}>Agent state (debug)</div>
              <Segmented
                label="Pi is"
                value={agentStateOverride}
                options={['auto', 'idle', 'thinking', 'working'] as const}
                onChange={applyAgentState}
              />
              <div className={styles.note}>
                Currently: <code>{runStateLive}</code>. "auto" follows the backend.
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
