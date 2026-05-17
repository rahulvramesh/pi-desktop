import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bug,
  ChevronRight,
  Eye,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Terminal,
  X,
} from 'lucide-react';
import type { FsEntry } from '../../shared/ipc.js';
import { useAgentStore } from '../stores/agent.js';
import { useProjectsStore } from '../stores/projects.js';
import { useUiStore } from '../stores/ui.js';
import type { AgentMessage, RpcLogEntry, ToolCallSummary } from '../../agent/backend.js';
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

function findLatestEditCard(msg: AgentMessage): ToolCallSummary | null {
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const p = msg.parts[i];
    if (!p || p.kind !== 'tool') continue;
    if (p.tool.name === 'edit' || p.tool.name === 'write') return p.tool;
  }
  return null;
}

function DiffView() {
  const latest = useAgentStore((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const msg = s.messages[i];
      if (!msg) continue;
      const card = findLatestEditCard(msg);
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

function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  select,
}: {
  node: FsEntry;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedPath: string;
  select: (path: string) => void;
}) {
  const indent = 10 + depth * 12;
  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <div
          className={styles.fileRow}
          style={{ paddingLeft: indent }}
          onClick={() => toggle(node.path)}
          role="button"
          tabIndex={0}
        >
          <ChevronRight
            size={12}
            className={`${styles.chev} ${isOpen ? styles.chevOpen : ''}`}
          />
          {isOpen ? (
            <FolderOpen size={14} className={styles.iconAccent} />
          ) : (
            <Folder size={14} className={styles.iconAccent} />
          )}
          <span>{node.name}</span>
        </div>
        {isOpen &&
          node.children?.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selectedPath={selectedPath}
              select={select}
            />
          ))}
      </>
    );
  }

  return (
    <div
      className={`${styles.fileRow} ${node.path === selectedPath ? styles.fileSelected : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => select(node.path)}
      role="button"
      tabIndex={0}
    >
      <span className={styles.chevSpace} />
      <FileCode2 size={14} className={styles.iconMuted} />
      <span>{node.name}</span>
    </div>
  );
}

/**
 * Files tab — the *real* on-disk tree for the active project, fetched through
 * the sandboxed fs:tree IPC. No project open ⇒ a hint instead of a fake tree.
 */
function FilesView() {
  const projectPath = useProjectsStore((s) => s.activeProjectPath());
  const [tree, setTree] = useState<FsEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectPath) {
      setTree([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.pi.fs
      .tree(projectPath)
      .then((t) => {
        if (cancelled) return;
        setTree(t);
        setExpanded(new Set(t.filter((n) => n.type === 'dir').map((n) => n.path)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  if (!projectPath) {
    return <div className={styles.empty}>Open a project to browse its files.</div>;
  }
  if (loading && tree.length === 0) {
    return <div className={styles.empty}>Loading files…</div>;
  }
  if (tree.length === 0) {
    return <div className={styles.empty}>No files found in this project.</div>;
  }

  return (
    <div className={styles.files}>
      <div className={styles.treeSection}>Files</div>
      {tree.map((n) => (
        <TreeNode
          key={n.path}
          node={n}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selectedPath={selected}
          select={setSelected}
        />
      ))}
    </div>
  );
}

function Stub({ label }: { label: string }) {
  return <div className={styles.empty}>{label} — stubbed in P1–P3</div>;
}

type RpcFilter = 'all' | RpcLogEntry['direction'];

const RPC_FILTERS: readonly RpcFilter[] = ['all', 'request', 'response', 'event', 'stderr', 'stdout'];

function formatRpcTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatRpcPayload(entry: RpcLogEntry): string {
  if (entry.payload === undefined) return entry.raw;
  try {
    return JSON.stringify(entry.payload, null, 2) ?? entry.raw;
  } catch {
    return entry.raw;
  }
}

function rpcDirectionClass(entry: RpcLogEntry): string {
  switch (entry.direction) {
    case 'request':
      return styles.rpcRequest ?? '';
    case 'response':
      return entry.success === false ? (styles.rpcError ?? '') : (styles.rpcResponse ?? '');
    case 'event':
      return styles.rpcEvent ?? '';
    case 'stderr':
      return styles.rpcError ?? '';
    case 'stdout':
      return styles.rpcStdout ?? '';
    default:
      return '';
  }
}

function RpcLogView() {
  const [entries, setEntries] = useState<RpcLogEntry[]>([]);
  const [filter, setFilter] = useState<RpcFilter>('all');
  const [query, setQuery] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.pi.rpcLogs.list().then((logs) => {
      if (!cancelled) setEntries(logs);
    });
    const unsubscribe = window.pi.rpcLogs.subscribe((entry) => {
      setEntries((prev) => [...prev, entry].slice(-800));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const filtered = useMemo(() => {
    const byDirection = filter === 'all' ? entries : entries.filter((entry) => entry.direction === filter);
    const q = query.trim().toLowerCase();
    if (!q) return byDirection;
    return byDirection.filter((entry) => {
      const haystack = [
        entry.direction,
        entry.method ?? '',
        entry.requestId ?? '',
        entry.error ?? '',
        entry.raw,
        formatRpcPayload(entry),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, filter, query]);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [autoscroll, filtered.length]);

  const clear = () => {
    setEntries([]);
    void window.pi.rpcLogs.clear();
  };

  const copyVisible = async () => {
    const text = filtered
      .map((entry) => {
        const header = [
          formatRpcTime(entry.timestamp),
          entry.direction.toUpperCase(),
          entry.method ?? '—',
          entry.requestId ?? '',
          entry.durationMs !== undefined ? `${entry.durationMs}ms` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `${header}\n${formatRpcPayload(entry)}`;
      })
      .join('\n\n---\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1_500);
    }
  };

  return (
    <div className={styles.rpcPanel}>
      <div className={styles.rpcToolbar}>
        <div className={styles.rpcTitle}>RPC trace</div>
        <span className={styles.rpcCount}>{filtered.length === entries.length ? entries.length : `${filtered.length}/${entries.length}`}</span>
        <button type="button" className={styles.rpcClear} onClick={copyVisible} disabled={filtered.length === 0}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy visible'}
        </button>
        <button type="button" className={styles.rpcClear} onClick={clear} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
      <div className={styles.rpcSearchRow}>
        <input
          className={styles.rpcSearchInput}
          aria-label="Search RPC logs"
          placeholder="Search JSON, method, id…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          type="button"
          className={`${styles.rpcFilter} ${autoscroll ? styles.rpcFilterActive : ''}`}
          aria-pressed={autoscroll}
          onClick={() => setAutoscroll((v) => !v)}
        >
          follow
        </button>
      </div>
      <div className={styles.rpcFilters}>
        {RPC_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.rpcFilter} ${filter === f ? styles.rpcFilterActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className={styles.rpcList}>
        {filtered.length === 0 ? (
          <div className={styles.rpcEmpty}>
            No RPC traffic yet. Open a chat with the <code>rpc-local</code> backend and send a
            prompt to see JSONL requests, responses, events, and stderr here.
          </div>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id} className={`${styles.rpcEntry} ${rpcDirectionClass(entry)}`}>
              <div className={styles.rpcEntryHead}>
                <span className={styles.rpcDirection}>{entry.direction}</span>
                <span className={styles.rpcMethod}>{entry.method ?? '—'}</span>
                {entry.requestId && <span className={styles.rpcId}>{entry.requestId}</span>}
                <span className={styles.rpcTime}>{formatRpcTime(entry.timestamp)}</span>
              </div>
              {(entry.durationMs !== undefined || entry.error || entry.direction === 'request' || entry.direction === 'response') && (
                <div className={styles.rpcMeta}>
                  {entry.direction === 'request' && (
                    <span>{entry.expectResponse === false ? 'fire-and-forget' : 'expects response'}</span>
                  )}
                  {entry.direction === 'response' && <span>{entry.success === false ? 'failed' : 'ok'}</span>}
                  {entry.durationMs !== undefined && <span>{entry.durationMs}ms</span>}
                  {entry.error && <span className={styles.rpcErrText}>{entry.error}</span>}
                </div>
              )}
              <pre className={styles.rpcRaw}>{formatRpcPayload(entry)}</pre>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export function InspectorPane() {
  const rightPane = useUiStore((s) => s.rightPane);
  const devMode = useUiStore((s) => s.devMode);
  const patch = useUiStore((s) => s.patch);

  const tab = useMemo(() => {
    const next = rightPane === 'none' ? 'files' : rightPane;
    return next === 'rpc' && !devMode ? 'files' : next;
  }, [devMode, rightPane]);

  return (
    <aside className={styles.pane}>
      <div className={styles.head}>
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'files' ? styles.tabActive : ''}`}
            onClick={() => void patch({ rightPane: 'files' })}
          >
            <FileCode2 size={11} />
            <span className={styles.tabLabel}>Files</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'diff' ? styles.tabActive : ''}`}
            onClick={() => void patch({ rightPane: 'diff' })}
          >
            <GitBranch size={11} />
            <span className={styles.tabLabel}>Diff</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'term' ? styles.tabActive : ''}`}
            onClick={() => void patch({ rightPane: 'term' })}
          >
            <Terminal size={11} />
            <span className={styles.tabLabel}>Terminal</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'preview' ? styles.tabActive : ''}`}
            onClick={() => void patch({ rightPane: 'preview' })}
          >
            <Eye size={11} />
            <span className={styles.tabLabel}>Preview</span>
          </button>
          {devMode && (
            <button
              className={`${styles.tab} ${tab === 'rpc' ? styles.tabActive : ''}`}
              onClick={() => void patch({ rightPane: 'rpc' })}
            >
              <Bug size={11} />
              <span className={styles.tabLabel}>RPC</span>
            </button>
          )}
        </div>
        <button
          className={styles.iconBtn}
          onClick={() => void patch({ rightPane: 'none' })}
          aria-label="Close inspector"
          title="Hide panel"
        >
          <X size={13} />
        </button>
      </div>
      <div className={styles.body}>
        {tab === 'files' && <FilesView />}
        {tab === 'diff' && <DiffView />}
        {tab === 'term' && <Stub label="Terminal" />}
        {tab === 'preview' && <Stub label="Preview" />}
        {tab === 'rpc' && <RpcLogView />}
      </div>
    </aside>
  );
}
