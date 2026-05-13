import { useMemo } from 'react';
import { Eye, GitBranch, Terminal, X } from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
import { useUiStore } from '../stores/ui.js';
import type { ToolCallSummary } from '../../agent/backend.js';
import styles from './InspectorPane.module.css';

/**
 * Parse the preview text of an edit/diff-shaped tool result into colored hunk
 * lines (+ / − / ctx). The mock backend emits its preview in the same shape
 * the design prototype uses.
 */
function renderDiffLines(preview: string) {
  return preview.split('\n').map((line, idx) => {
    if (line.startsWith('+')) {
      return (
        <span key={idx} className={styles.add}>
          {line}
          {'\n'}
        </span>
      );
    }
    if (line.startsWith('-')) {
      return (
        <span key={idx} className={styles.del}>
          {line}
          {'\n'}
        </span>
      );
    }
    return (
      <span key={idx} className={styles.ctx}>
        {line}
        {'\n'}
      </span>
    );
  });
}

function findLatestEditCard(toolCalls: ToolCallSummary[]): ToolCallSummary | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const t = toolCalls[i];
    if (!t) continue;
    if (t.name === 'edit' || t.name === 'write') return t;
  }
  return null;
}

function DiffView() {
  const latest = useAgentStore((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const msg = s.messages[i];
      if (!msg) continue;
      const card = findLatestEditCard(msg.toolCalls);
      if (card) return card;
    }
    return null;
  });

  if (!latest || !latest.preview) {
    return (
      <div className={styles.empty}>
        No edits yet — when the agent runs `edit` or `write`, the resulting diff appears here.
      </div>
    );
  }
  return (
    <div className={styles.diff}>
      <div className={styles.diffHead}>
        <span className={styles.diffPath}>{latest.arg}</span>
        {latest.stats && (
          <span className={styles.diffStats}>
            <span className={styles.add}>+{latest.stats.add}</span>
            <span className={styles.del}>−{latest.stats.del}</span>
          </span>
        )}
      </div>
      <pre className={styles.pre}>{renderDiffLines(latest.preview)}</pre>
    </div>
  );
}

function Stub({ label }: { label: string }) {
  return <div className={styles.empty}>{label} — stubbed in P1–P3</div>;
}

export function InspectorPane() {
  const rightPane = useUiStore((s) => s.rightPane);
  const patch = useUiStore((s) => s.patch);

  const tab = useMemo(() => (rightPane === 'none' ? 'diff' : rightPane), [rightPane]);

  return (
    <aside className={styles.pane}>
      <div className={styles.head}>
        <button
          className={`${styles.tab} ${tab === 'diff' ? styles.tabActive : ''}`}
          onClick={() => void patch({ rightPane: 'diff' })}
        >
          <GitBranch size={11} /> Diff
        </button>
        <button
          className={`${styles.tab} ${tab === 'term' ? styles.tabActive : ''}`}
          onClick={() => void patch({ rightPane: 'term' })}
        >
          <Terminal size={11} /> Terminal
        </button>
        <button
          className={`${styles.tab} ${tab === 'preview' ? styles.tabActive : ''}`}
          onClick={() => void patch({ rightPane: 'preview' })}
        >
          <Eye size={11} /> Preview
        </button>
        <span className={styles.spacer} />
        <button
          className={styles.iconBtn}
          onClick={() => void patch({ rightPane: 'none' })}
          aria-label="Close inspector"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>
      <div className={styles.body}>
        {tab === 'diff' && <DiffView />}
        {tab === 'term' && <Stub label="Terminal" />}
        {tab === 'preview' && <Stub label="Preview" />}
      </div>
    </aside>
  );
}
