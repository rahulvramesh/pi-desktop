import { Command, History, PanelLeft, Settings, Sparkles } from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
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

  return (
    <div className={styles.titlebar}>
      <div className={styles.left}>
        {/* Decorative traffic lights (real ones live on macOS native title bar). */}
        <div className={styles.trafficLights}>
          <span className={`${styles.tl} ${styles.tlRed}`} />
          <span className={`${styles.tl} ${styles.tlYellow}`} />
          <span className={`${styles.tl} ${styles.tlGreen}`} />
        </div>
        <button
          className={styles.iconBtn}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </button>
        <button className={styles.iconBtn} title="History (stubbed in P1–P3)" aria-label="History">
          <History size={14} />
        </button>
      </div>

      <div className={styles.center}>
        <PiGlyph size={16} />
        <span className={styles.crumb}>Pi</span>
        <span className={styles.sep}>/</span>
        <span className={styles.crumb}>openclaw</span>
        <span className={styles.sep}>/</span>
        <span className={styles.crumbActive}>Level loader v2</span>
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
          className={styles.iconBtn}
          title="Tweaks (⌥T)"
          aria-label="Tweaks"
          onClick={toggleTweaks}
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}
