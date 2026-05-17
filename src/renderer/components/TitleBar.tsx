import { useEffect, useState } from 'react';
import {
  Command,
  Minus,
  PanelLeft,
  PanelRight,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
import { useProjectsStore } from '../stores/projects.js';
import { useUiStore } from '../stores/ui.js';
import { PiGlyph } from './PiGlyph.js';
import { StatusPill } from './StatusPill.js';
import styles from './TitleBar.module.css';

/**
 * Window title bar.
 *
 * - Traffic lights are owned by the OS on macOS (titleBarStyle: 'hiddenInset')
 *   so we render decorative dots only on non-mac, both for consistency with
 *   the design prototype and to give us a draggable surface there.
 * - Center: π glyph + breadcrumb. The active leaf is ink-1; ancestors ink-3.
 * - Status pill animates while the agent runs (§x).
 * - Right side: command palette stub, welcome (no-op stub for P1–P3), settings stub.
 *   These are all wired to the tweaks panel toggle until later phases.
 */
export function TitleBar() {
  const runState = useAgentStore((s) => s.runState);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleTweaks = useUiStore((s) => s.toggleTweaks);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const projectName = useProjectsStore((s) => s.activeProject()?.name ?? null);
  const chatTitle = useProjectsStore((s) => s.activeChat()?.title ?? null);
  const rightPane = useUiStore((s) => s.rightPane);
  const patch = useUiStore((s) => s.patch);
  const rightVisible = rightPane !== 'none';
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    return window.pi.window.onMaximizedChange(setIsMaximized);
  }, []);

  return (
    <div className={styles.titlebar}>
      <div className={styles.left}>
        {/* macOS-style decorative traffic lights, wired to OS window controls.
            Shown only on macOS-likes (or Linux where there's no platform
            convention) — Windows gets right-aligned controls below; macOS
            itself hides these via [data-platform='darwin'] because the OS
            draws real lights in this slot. */}
        <div className={styles.trafficLights} role="group" aria-label="Window controls">
          <button
            type="button"
            className={`${styles.tl} ${styles.tlRed}`}
            onClick={() => void window.pi.window.close()}
            aria-label="Close window"
            title="Close"
          >
            <span className={styles.tlIcon}>×</span>
          </button>
          <button
            type="button"
            className={`${styles.tl} ${styles.tlYellow}`}
            onClick={() => void window.pi.window.minimize()}
            aria-label="Minimize window"
            title="Minimize"
          >
            <span className={styles.tlIcon}>–</span>
          </button>
          <button
            type="button"
            className={`${styles.tl} ${styles.tlGreen}`}
            onClick={() => void window.pi.window.maximizeToggle()}
            aria-label="Maximize window"
            title="Maximize"
          >
            <span className={styles.tlIcon}>+</span>
          </button>
        </div>
        <button
          className={styles.iconBtn}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className={`${styles.iconBtn} ${rightVisible ? styles.iconBtnActive : ''}`}
          title={rightVisible ? 'Hide files panel' : 'Show files panel'}
          aria-label="Toggle files panel"
          aria-pressed={rightVisible}
          onClick={() => void patch({ rightPane: rightVisible ? 'none' : 'files' })}
        >
          <PanelRight size={14} />
        </button>
      </div>

      <div className={styles.center}>
        <PiGlyph size={16} />
        <span
          className={styles.crumb}
          role="button"
          tabIndex={0}
          onClick={() => setView('chat')}
          title="Back to chat"
        >
          Pi
        </span>
        {projectName && (
          <>
            <span className={styles.sep}>/</span>
            <span
              className={styles.crumb}
              role="button"
              tabIndex={0}
              onClick={() => setView('chat')}
            >
              {projectName}
            </span>
          </>
        )}
        {(view === 'settings' || chatTitle) && (
          <>
            <span className={styles.sep}>/</span>
            <span className={styles.crumbActive}>
              {view === 'settings' ? 'Settings' : chatTitle}
            </span>
          </>
        )}
        <span className={styles.pillSlot}>
          <StatusPill state={runState} />
        </span>
      </div>

      <div className={styles.right}>
        <button
          className={styles.iconBtn}
          title="Command palette (stubbed shortcut ⌘K)"
          aria-label="Command palette"
        >
          <Command size={14} />
        </button>
        <button
          className={styles.iconBtn}
          title="Welcome (stubbed)"
          aria-label="Welcome"
        >
          <Sparkles size={14} />
        </button>
        <button
          className={`${styles.iconBtn} ${view === 'settings' ? styles.iconBtnActive : ''}`}
          title="Settings"
          aria-label="Settings"
          aria-pressed={view === 'settings'}
          onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
        >
          <Settings size={14} />
        </button>
        <button
          className={styles.iconBtn}
          title="Tweaks (⌥T)"
          aria-label="Tweaks"
          onClick={toggleTweaks}
        >
          <SlidersHorizontal size={14} />
        </button>

        {/* Windows-style window controls. Hidden on macOS (OS draws them on
            the left) and on Linux variants where the design's macOS-style
            dots are used instead. */}
        <div
          className={styles.winControls}
          role="group"
          aria-label="Window controls"
        >
          <button
            type="button"
            className={styles.winBtn}
            onClick={() => void window.pi.window.minimize()}
            aria-label="Minimize window"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className={styles.winBtn}
            onClick={() => void window.pi.window.maximizeToggle()}
            aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <rect x="2.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor" />
                <rect x="0.5" y="2.5" width="8" height="8" fill="var(--surface)" stroke="currentColor" />
              </svg>
            ) : (
              <Square size={12} strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            className={`${styles.winBtn} ${styles.winBtnClose}`}
            onClick={() => void window.pi.window.close()}
            aria-label="Close window"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
