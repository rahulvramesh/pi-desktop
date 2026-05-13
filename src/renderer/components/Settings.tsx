import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Cpu,
  Download,
  Edit3,
  Info,
  Moon,
  Plus,
  Puzzle,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { useUiStore } from '../stores/ui.js';
import type { PrefsShape } from '../../shared/ipc.js';
import styles from './Settings.module.css';

/**
 * Settings screen — distilled from the design bundle's Screens.jsx.
 *
 * Wiring policy for P3:
 *  - Theme and Density write through to electron-store via useUiStore.patch,
 *    so changes here are persisted across reloads and mirror the tweaks panel.
 *  - Every other control renders verbatim from the design but is local-state
 *    only. The agent-configuration knobs (AGENTS.md cascade, SYSTEM.md,
 *    compaction, permissions, providers list, models.json path) need backend
 *    plumbing that lives outside P1–P3 — those keep their design-faithful
 *    look here so the screen is reviewable, but flipping a toggle does not
 *    yet reach into ~/.pi/.
 */

interface Row {
  lbl: string;
  help: string;
  ctrl: ReactNode;
}
interface Section {
  title: string;
  rows: Row[];
}

function Toggle({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange?: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
      aria-pressed={on}
      aria-label={ariaLabel}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function Chip({
  children,
  on,
  onClick,
}: {
  children: ReactNode;
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <span
      className={`${styles.chip} ${on ? styles.chipOn : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
    >
      <span className={styles.chipDot} />
      {children}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className={styles.kbd}>{children}</span>;
}

export function Settings() {
  const setView = useUiStore((s) => s.setView);
  const theme = useUiStore((s) => s.theme);
  const density = useUiStore((s) => s.density);
  const patch = useUiStore((s) => s.patch);

  // Local UI state for the bits not yet plumbed to a backend.
  const [agentsCascade, setAgentsCascade] = useState(true);
  const [systemOverride, setSystemOverride] = useState(false);
  const [compaction, setCompaction] = useState(true);
  const [network, setNetwork] = useState(true);

  const themeChip = (
    value: PrefsShape['theme'],
    icon: ReactNode,
    label: string,
  ): ReactNode => (
    <Chip on={theme === value} onClick={() => void patch({ theme: value })}>
      {icon}
      {label}
    </Chip>
  );

  const densityChip = (value: PrefsShape['density']): ReactNode => (
    <Chip on={density === value} onClick={() => void patch({ density: value })}>
      {value}
    </Chip>
  );

  const sections: Section[] = [
    {
      title: 'Account',
      rows: [
        {
          lbl: 'Signed in',
          help: 'Earendil account',
          ctrl: (
            <>
              <div className={styles.avatar}>MA</div>
              <span style={{ fontSize: 13 }}>M. Adler · m@earendil.com</span>
              <button className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}>Sign out</button>
            </>
          ),
        },
        {
          lbl: 'Plan',
          help: 'Pro · resets May 28',
          ctrl: (
            <>
              <span className={`${styles.pill} ${styles.pillAccent}`}>Pro</span>
              <button className={`${styles.btn} ${styles.btnSm}`}>Manage</button>
            </>
          ),
        },
      ],
    },
    {
      title: 'Providers & models',
      rows: [
        {
          lbl: 'Default model',
          help: 'Used for new sessions',
          ctrl: (
            <div className={styles.picker}>
              <Cpu size={12} />
              <span className={`${styles.mono} ${styles.small}`}>claude-sonnet-4-6</span>
              <ChevronDown size={11} />
            </div>
          ),
        },
        {
          lbl: 'Authenticated',
          help: 'API keys live in ~/.pi/auth/ — none are written by this app',
          ctrl: (
            <div className={styles.chips}>
              {['anthropic', 'openai', 'google', 'moonshot', 'deepseek', 'ollama'].map((p) => (
                <Chip key={p} on>
                  {p}
                </Chip>
              ))}
              <Chip>azure</Chip>
              <Chip>bedrock</Chip>
              <button className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}>
                <Plus size={11} /> add
              </button>
            </div>
          ),
        },
        {
          lbl: 'models.json',
          help: 'Custom providers & model aliases',
          ctrl: (
            <>
              <input className={`${styles.input} ${styles.mono}`} defaultValue="~/.pi/models.json" />
              <button className={`${styles.btn} ${styles.btnSm}`}>
                <Edit3 size={11} /> Open
              </button>
            </>
          ),
        },
      ],
    },
    {
      title: 'Context engineering',
      rows: [
        {
          lbl: 'AGENTS.md cascade',
          help: 'Loaded from ~/.pi → parents → cwd',
          ctrl: (
            <>
              <Toggle on={agentsCascade} onChange={() => setAgentsCascade((v) => !v)} ariaLabel="AGENTS.md cascade" />
              <span className={styles.small}>3 files loaded · 412 tokens</span>
            </>
          ),
        },
        {
          lbl: 'SYSTEM.md override',
          help: 'Per-project system prompt',
          ctrl: (
            <>
              <Toggle on={systemOverride} onChange={() => setSystemOverride((v) => !v)} ariaLabel="SYSTEM.md override" />
              <span className={`${styles.small} ${styles.muted}`}>
                {systemOverride ? 'using ./.pi/SYSTEM.md' : 'Using Pi defaults'}
              </span>
            </>
          ),
        },
        {
          lbl: 'Compaction',
          help: 'Auto-summarize old turns near context limit',
          ctrl: (
            <>
              <Toggle on={compaction} onChange={() => setCompaction((v) => !v)} ariaLabel="Compaction" />
              <span className={styles.small}>at 80% · code-aware model</span>
            </>
          ),
        },
        {
          lbl: 'Skills',
          help: 'Loaded on demand — progressive disclosure',
          ctrl: (
            <div className={styles.chips}>
              {['level-format', 'asset-rip'].map((s) => (
                <Chip key={s} on>
                  {s}
                </Chip>
              ))}
              <Chip>git-flow</Chip>
            </div>
          ),
        },
      ],
    },
    {
      title: 'Permissions',
      rows: [
        {
          lbl: 'Bash policy',
          help: 'Pi runs in this directory unless told otherwise',
          ctrl: (
            <div className={styles.chips}>
              <Chip on>auto-allow reads</Chip>
              <Chip on>confirm writes outside repo</Chip>
              <Chip>sandbox via @earendil/pi-sandbox</Chip>
            </div>
          ),
        },
        {
          lbl: 'Protected paths',
          help: 'Pi refuses to write here',
          ctrl: (
            <input
              className={`${styles.input} ${styles.mono} ${styles.inputWide}`}
              defaultValue=".env, ~/.ssh, ~/.aws"
            />
          ),
        },
        {
          lbl: 'Network access',
          help: 'Outbound HTTP from tool calls',
          ctrl: (
            <>
              <Toggle on={network} onChange={() => setNetwork((v) => !v)} ariaLabel="Network access" />
              <span className={styles.small}>
                {network ? 'allowed · domain allow-list active' : 'blocked'}
              </span>
            </>
          ),
        },
      ],
    },
    {
      title: 'Appearance',
      rows: [
        {
          lbl: 'Theme',
          help: 'Persisted via electron-store',
          ctrl: (
            <div className={styles.chips}>
              {themeChip('light', <Sun size={10} />, 'paper')}
              {themeChip('dark', <Moon size={10} />, 'ink')}
            </div>
          ),
        },
        {
          lbl: 'Font',
          help: 'Used in chat and editor',
          ctrl: (
            <>
              <input className={styles.input} defaultValue="Geist" readOnly />
              <span className={`${styles.small} ${styles.muted}`}>+ Geist Mono</span>
            </>
          ),
        },
        {
          lbl: 'Density',
          help: 'Padding and row height across the app',
          ctrl: (
            <div className={styles.chips}>
              {densityChip('compact')}
              {densityChip('regular')}
              {densityChip('comfy')}
            </div>
          ),
        },
      ],
    },
    {
      title: 'Keyboard',
      rows: [
        { lbl: 'Send', help: 'Submit the composer', ctrl: <Kbd>⏎</Kbd> },
        { lbl: 'Newline', help: 'Add a line break inside the composer', ctrl: <Kbd>⇧⏎</Kbd> },
        { lbl: 'Stop', help: 'Abort the running agent', ctrl: <Kbd>⌃C</Kbd> },
        {
          lbl: 'Tweaks',
          help: 'Toggle the floating tweaks panel',
          ctrl: (
            <>
              <Kbd>⌥</Kbd>
              <Kbd>T</Kbd>
            </>
          ),
        },
        { lbl: 'Command palette', help: 'Stub in P1–P3; opens nothing today', ctrl: <Kbd>⌘K</Kbd> },
      ],
    },
  ];

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <button
          className={styles.backBtn}
          onClick={() => setView('chat')}
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <SettingsIcon size={15} className={styles.headerIcon} />
        <span className={styles.headerTitle}>Settings</span>
        <span className={styles.spacer} />
        <button className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}>
          <Download size={12} /> Export config
        </button>
      </div>

      <div className={styles.body}>
        <h1 className={styles.h1}>Settings</h1>
        <p className={styles.lede}>
          Everything Pi can do is also a file in <span className={styles.monoInline}>~/.pi/</span>.
          Edit by hand or right here. P1–P3 wires <em>Theme</em> and <em>Density</em>; the rest are
          presentational scaffolding for the next phases.
        </p>

        {sections.map((s) => (
          <div key={s.title} className={styles.group}>
            <h3 className={styles.groupH3}>{s.title}</h3>
            {s.rows.map((r, i) => (
              <div key={i} className={styles.row}>
                <div>
                  <div className={styles.rowLbl}>{r.lbl}</div>
                  <div className={styles.rowHelp}>{r.help}</div>
                </div>
                <div className={styles.rowCtrl}>{r.ctrl}</div>
              </div>
            ))}
          </div>
        ))}

        <div className={styles.callout}>
          <Info size={18} className={styles.calloutIcon} />
          <div className={styles.calloutBody}>
            <div className={styles.calloutTitle}>Need something Pi doesn't do?</div>
            <div className={styles.calloutSub}>
              Ask Pi to build it as an extension — or install one from a package.
            </div>
          </div>
          <span className={styles.spacer} />
          <button className={`${styles.btn} ${styles.btnSm}`}>
            <Puzzle size={12} /> Browse packages
          </button>
        </div>
      </div>
    </section>
  );
}
