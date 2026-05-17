import { useEffect, useState } from 'react';
import { Cpu, GitBranch, GitMerge } from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
import { useProjectsStore } from '../stores/projects.js';
import type { AgentState } from '../../agent/backend.js';
import type { AppMeta } from '../../shared/ipc.js';
import styles from './StatusBar.module.css';

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatUsage(state: AgentState): string {
  const parts: string[] = [];
  if (state.tokenUsage.input > 0) parts.push(`↑${formatTokenCount(state.tokenUsage.input)}`);
  if (state.tokenUsage.output > 0) parts.push(`↓${formatTokenCount(state.tokenUsage.output)}`);
  if (state.tokenUsage.cacheRead > 0) parts.push(`R${formatTokenCount(state.tokenUsage.cacheRead)}`);
  if (state.tokenUsage.cacheWrite > 0) parts.push(`W${formatTokenCount(state.tokenUsage.cacheWrite)}`);
  if (state.costUsd > 0 || state.tokenUsage.total > 0) parts.push(`$${state.costUsd.toFixed(3)}`);
  const pct = state.contextPercent == null ? '?' : state.contextPercent.toFixed(1);
  parts.push(`${pct}%/${formatTokenCount(state.tokensMax)}${state.autoCompactionEnabled ? ' (auto)' : ''}`);
  return parts.join(' ');
}

export function StatusBar() {
  const state = useAgentStore((s) => s.state);
  const projectPath = useProjectsStore((s) => s.activeProject()?.path ?? null);
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [git, setGit] = useState<{ branch: string | null; modified: number }>({
    branch: null,
    modified: 0,
  });

  useEffect(() => {
    let cancelled = false;
    void window.pi.meta().then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh git status when the active project changes, and again whenever a
  // run finishes (the agent likely edited files).
  useEffect(() => {
    if (!projectPath) {
      setGit({ branch: null, modified: 0 });
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.pi.git.status(projectPath).then((g) => {
        if (!cancelled) setGit(g);
      });
    };
    refresh();
    const unsub = window.pi.subscribe((ev) => {
      if (ev.type === 'agent_end') refresh();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [projectPath]);

  return (
    <footer className={styles.bar}>
      {git.branch && (
        <span className={styles.item}>
          <GitBranch size={11} /> {git.branch}
        </span>
      )}
      {git.branch && git.modified > 0 && (
        <span className={styles.item}>
          <GitMerge size={11} /> {git.modified} modified
        </span>
      )}
      <span className={styles.item} title={`${state.modelProvider}:${state.modelId}`}>
        <Cpu size={11} /> {state.modelId}
      </span>
      <span className={`${styles.item} ${styles.usage}`} title="Input / output / cache read / cache write / cost / context">
        {formatUsage(state)}
      </span>
      <span className={styles.spacer} />
      <span className={styles.item}>{meta?.backend ?? '…'}</span>
      <span className={styles.item}>UTF-8 · LF</span>
      <span className={styles.item}>v{meta?.version ?? '0.1.0'}</span>
    </footer>
  );
}
