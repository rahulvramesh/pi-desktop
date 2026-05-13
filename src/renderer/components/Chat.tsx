import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Cpu, Info, PanelLeft, Sparkles, Square } from 'lucide-react';
import { useAgentStore } from '../stores/agent.js';
import { useUiStore } from '../stores/ui.js';
import type { AgentMessage } from '../../agent/backend.js';
import { ToolCallCard } from './ToolCallCard.js';
import styles from './Chat.module.css';

function MessageView({ m, isLast }: { m: AgentMessage; isLast: boolean }) {
  const runState = useAgentStore((s) => s.runState);
  const isUser = m.role === 'user';
  const isAgent = m.role === 'assistant';
  return (
    <div className={`${styles.msg} ${isUser ? styles.user : styles.agent}`}>
      <div className={styles.avatar}>{isUser ? 'MA' : 'π'}</div>
      <div className={styles.body}>
        <div className={styles.meta}>
          <b>{isUser ? 'You' : 'Pi'}</b>
          <span>·</span>
          <span>{m.time}</span>
          {isAgent && isLast && runState !== 'idle' && (
            <>
              <span>·</span>
              <span className={styles.thinking}>
                <Sparkles size={11} />
                <span>{runState === 'thinking' ? 'thinking' : 'working'}</span>
                <span className={styles.tdots}>
                  <span /> <span /> <span />
                </span>
              </span>
            </>
          )}
        </div>
        {m.text && <div className={styles.text}>{m.text}</div>}
        {m.toolCalls.map((t, i) => (
          <ToolCallCard key={t.toolCallId} tool={t} defaultOpen={i === 0} />
        ))}
      </div>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const runState = useAgentStore((s) => s.runState);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const abort = useAgentStore((s) => s.abort);
  const running = runState !== 'idle';

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void send();
    }
  };

  const send = async () => {
    if (text.trim().length === 0) return;
    const t = text;
    setText('');
    await sendPrompt(t);
  };

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={text}
          placeholder={
            running
              ? 'Steer the agent — Enter sends now, Alt+Enter queues a follow-up'
              : 'Ask Pi to refactor, debug, run, explain…'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          aria-label="Message Pi"
        />
        <div className={styles.foot}>
          <span className={styles.picker}>
            <Cpu size={12} className={styles.iconMuted} />
            <span className={styles.modelText}>claude-sonnet-4.6</span>
          </span>
          <span className={styles.spacer} />
          <span className={styles.shortcuts}>
            <kbd>⏎</kbd> {running ? 'steer' : 'send'} &nbsp;
            <kbd>⇧⏎</kbd> newline &nbsp;
            <kbd>⌃C</kbd> stop
          </span>
          {running ? (
            <button
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => void abort()}
              title="Stop"
            >
              <Square size={11} /> Stop
            </button>
          ) : (
            <button
              className={`${styles.btn} ${styles.primary} ${styles.btnSm}`}
              onClick={() => void send()}
              disabled={text.trim().length === 0}
              title="Send (Enter)"
            >
              <ArrowUp size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Chat() {
  const messages = useAgentStore((s) => s.messages);
  const runState = useAgentStore((s) => s.runState);
  const lastError = useAgentStore((s) => s.lastError);
  const clearError = useAgentStore((s) => s.clearError);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content unless the user has scrolled up.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, runState]);

  return (
    <section className={styles.chat}>
      <div className={styles.header}>
        <button
          className={styles.iconBtn}
          title="Toggle sidebar"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={15} />
        </button>
        <div className={styles.headerMeta}>
          <span className={styles.title}>Level loader v2</span>
          <span className={styles.subPath}>~/projects/openclaw</span>
        </div>
      </div>

      <div className={styles.stream} ref={streamRef}>
        <div className={styles.inner}>
          <div className={styles.runStart}>
            <span className={styles.runStartRule} />
            <span className={styles.runStartText}>
              <Info size={11} /> session started · loaded AGENTS.md · interactive mode
            </span>
            <span className={styles.runStartRule} />
          </div>
          {messages.length === 0 && (
            <div className={styles.empty}>
              <h2>Hello — I am Pi.</h2>
              <p>Ask me to refactor, debug, run, or explain code. P1–P3 ships with a mock backend by default; export PI_BACKEND=sdk-local with ANTHROPIC_API_KEY set to drive Claude Sonnet.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageView key={m.id} m={m} isLast={i === messages.length - 1} />
          ))}
        </div>
      </div>

      {lastError && (
        <div className={styles.errorBanner} role="alert">
          <span>{lastError}</span>
          <button onClick={clearError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <Composer />
    </section>
  );
}
