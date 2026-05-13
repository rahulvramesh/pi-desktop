import { useState } from 'react';
import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Package,
  Plus,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { FILE_TREE, type FileNode } from '../data/file-tree.js';
import { PiGlyph } from './PiGlyph.js';
import styles from './Sidebar.module.css';

type Tab = 'files' | 'sessions' | 'skills' | 'packages';

const TABS: Array<{ id: Tab; label: string; icon: typeof FileCode2 }> = [
  { id: 'files', label: 'Files', icon: FileCode2 },
  { id: 'sessions', label: 'Sessions', icon: History },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'packages', label: 'Packages', icon: Package },
];

function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  select,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedPath: string;
  select: (path: string) => void;
}) {
  const indent = 8 + depth * 12;
  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <div
          className={styles.row}
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

  const isSelected = node.path === selectedPath;
  const cls = [
    styles.row,
    isSelected ? styles.selected : '',
    node.status === 'dirty' ? styles.dirty : '',
    node.status === 'added' ? styles.added : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      style={{ paddingLeft: indent }}
      onClick={() => select(node.path)}
      role="button"
      tabIndex={0}
    >
      <span className={styles.chevSpace} />
      <FileCode2 size={14} className={styles.iconMuted} />
      <span>{node.name}</span>
      {node.status === 'dirty' && <span className={styles.badgeDirty}>M</span>}
      {node.status === 'added' && <span className={styles.badgeAdded}>A</span>}
    </div>
  );
}

function StubBody({ label }: { label: string }) {
  return (
    <div className={styles.stub}>
      <span>{label} — stubbed in P1–P3</span>
    </div>
  );
}

/**
 * Sidebar with four tabs. Only Files is wired against the hardcoded tree; the
 * other three render a flat "stubbed" message until later phases.
 */
export function Sidebar() {
  const [tab, setTab] = useState<Tab>('files');
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(['.pi', '.pi/skills', 'src', 'src/levels', 'src/engine', 'tests']),
  );
  const [selected, setSelected] = useState('src/levels/Loader.ts');

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.project}>
        <PiGlyph size={22} />
        <div className={styles.projectMeta}>
          <span className={styles.projectName}>openclaw</span>
          <span className={styles.projectBranch}>
            <GitBranch size={10} /> feat/level-loader-v2
          </span>
        </div>
        <button className={styles.iconBtn} title="New session" aria-label="New session">
          <Plus size={14} />
        </button>
      </div>

      <div className={styles.tabs}>
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={13} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.search}>
        <Search size={13} className={styles.iconMuted} />
        <input placeholder={tab === 'files' ? 'Find file…' : 'Search…'} />
      </div>

      <div className={styles.body}>
        {tab === 'files' && (
          <>
            <div className={styles.section}>
              <span>Workspace</span>
            </div>
            {FILE_TREE.map((n) => (
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
            <div className={styles.section} style={{ marginTop: 14 }}>
              <span>Changes — 3</span>
            </div>
            <div className={`${styles.row} ${styles.added}`}>
              <span className={styles.chevSpace} />
              <FileCode2 size={14} className={styles.iconMuted} />
              <span>src/levels/schema.ts</span>
              <span className={styles.badgeAdded}>A</span>
            </div>
            <div className={`${styles.row} ${styles.dirty}`}>
              <span className={styles.chevSpace} />
              <FileCode2 size={14} className={styles.iconMuted} />
              <span>src/levels/Loader.ts</span>
              <span className={styles.badgeDirty}>M</span>
            </div>
            <div className={`${styles.row} ${styles.dirty}`}>
              <span className={styles.chevSpace} />
              <FileCode2 size={14} className={styles.iconMuted} />
              <span>tests/loader.test.ts</span>
              <span className={styles.badgeDirty}>M</span>
            </div>
          </>
        )}
        {tab === 'sessions' && <StubBody label="Sessions" />}
        {tab === 'skills' && <StubBody label="Skills" />}
        {tab === 'packages' && <StubBody label="Packages" />}
      </div>

      <div className={styles.footer}>
        <div className={styles.avatar}>MA</div>
        <div className={styles.userMeta}>
          <span className={styles.userName}>M. Adler</span>
          <span className={styles.userTier}>Pro · 1.4M tokens left</span>
        </div>
        <button className={styles.iconBtn} title="Settings" aria-label="Settings">
          <Settings size={14} />
        </button>
      </div>
    </aside>
  );
}
