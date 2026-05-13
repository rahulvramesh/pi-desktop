import { useEffect, useState } from 'react';
import { Cpu, GitBranch, GitMerge } from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
import type { AppMeta } from '../../shared/ipc.js';
import styles from './StatusBar.module.css';

function formatTokens(used: number, max: number): string {
  const fmt = (n: number) => (n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));
  return `${fmt(used)} / ${fmt(max)}`;
}

export function StatusBar() {
  const runState = useAgentStore((s) => s.runState);
  const state = useAgentStore((s) => s.state);
  const [meta, setMeta] = useState<AppMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.pi.meta().then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stateLabel = runState === 'idle' ? 'ready' : runState;
  const stateClass =
    runState === 'idle'
      ? styles.ok
      : runState === 'thinking' || runState === 'queued'
        ? styles.warn
        : styles.accent;

  return (
    <footer className={styles.bar}>
      <span className={`${styles.item} ${stateClass}`}>
        <span className={styles.dot} />
        <span>{stateLabel}</span>
      </span>
      <span className={styles.item}>
        <GitBranch size={11} /> feat/level-loader-v2
      </span>
      <span className={styles.item}>
        <GitMerge size={11} /> 3 modified
      </span>
      <span className={styles.item}>
        <Cpu size={11} /> {state.modelProvider}:{state.modelId} · {formatTokens(state.tokensUsed, state.tokensMax)}
      </span>
      <span className={styles.spacer} />
      <span className={styles.item}>{meta?.backend ?? '…'}</span>
      <span className={styles.item}>UTF-8 · LF</span>
      <span className={styles.item}>v{meta?.version ?? '0.1.0'}</span>
    </footer>
  );
}
