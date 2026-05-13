import type { AgentRunState } from '../../agent/backend.js';
import styles from './StatusPill.module.css';

interface Props {
  state: AgentRunState;
}

const LABEL: Record<AgentRunState, string> = {
  idle: 'ready',
  thinking: 'thinking',
  running: 'running',
  queued: 'queued',
};

export function StatusPill({ state }: Props) {
  if (state === 'idle') return null;
  return (
    <span className={styles.pill}>
      <span className={styles.dot} aria-hidden />
      <span>{LABEL[state]}</span>
    </span>
  );
}
