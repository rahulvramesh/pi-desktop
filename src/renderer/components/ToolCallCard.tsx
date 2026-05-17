import { useState } from 'react';
import {
  Book,
  ChevronRight,
  Edit3,
  FileSearch,
  GitBranch,
  Globe,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ToolCallSummary } from '../../agent/backend.js';
import { CodeBlock } from './CodeBlock.js';
import styles from './ToolCallCard.module.css';

/** Render a unified-diff-shaped preview with +/− line coloring. */
function renderDiff(preview: string) {
  return preview.split('\n').map((line, idx) => {
    const cls =
      line.startsWith('+') && !line.startsWith('+++')
        ? styles.diffAdd
        : line.startsWith('-') && !line.startsWith('---')
          ? styles.diffDel
          : styles.diffCtx;
    return (
      <span key={idx} className={cls}>
        {line || ' '}
        {'\n'}
      </span>
    );
  });
}

const TOOL_ICON: Record<string, typeof Wrench> = {
  read: Book,
  edit: Edit3,
  write: Edit3,
  bash: Terminal,
  grep: Search,
  glob: FileSearch,
  web: Globe,
  git: GitBranch,
};

function durationLabel(t?: number): string {
  if (t == null) return '—';
  return `${t.toFixed(1)}s`;
}

interface Props {
  tool: ToolCallSummary;
  /** Whether this is the first tool card on its message — controls auto-open. */
  defaultOpen?: boolean;
}

export function ToolCallCard({ tool, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = TOOL_ICON[tool.name] ?? Wrench;
  const running = tool.status === 'running';

  return (
    <div className={styles.card}>
      <div
        className={styles.head}
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          className={`${styles.chev} ${open ? styles.chevOpen : ''}`}
        />
        <Icon size={13} className={styles.icon} />
        <span className={styles.name}>{tool.name}</span>
        <span className={styles.arg}>{tool.arg}</span>
        {tool.stats && (
          <span className={styles.stats}>
            <span className={styles.add}>+{tool.stats.add}</span>
            <span className={styles.del}>−{tool.stats.del}</span>
          </span>
        )}
        <span
          className={`${styles.status} ${
            running ? styles.run : tool.status === 'error' ? styles.error : styles.ok
          }`}
        >
          {running ? <span className={styles.dots} aria-label="running" /> : tool.status === 'error' ? '✕' : '✓'}
        </span>
        <span className={styles.time}>{durationLabel(tool.durationSeconds)}</span>
      </div>
      {open && tool.preview && (
        <div className={styles.body}>
          {tool.name === 'edit' || tool.name === 'write' || tool.stats != null ? (
            <pre className={styles.pre}>{renderDiff(tool.preview)}</pre>
          ) : (
            <CodeBlock code={tool.preview} arg={tool.arg} />
          )}
        </div>
      )}
    </div>
  );
}
