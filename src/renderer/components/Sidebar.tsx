import { useEffect } from 'react';
import {
  ChevronRight,
  Clock,
  FolderPlus,
  Folder,
  LayoutGrid,
  Search,
  Settings,
  Box,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { Chat } from '../../shared/ipc.js';
import { useProjectsStore } from '../stores/projects.js';
import { useUiStore } from '../stores/ui.js';
import { SoftCells } from './SoftCells.js';
import styles from './Sidebar.module.css';

type NavId = 'new' | 'search' | 'skills' | 'plugins' | 'automations';

const NAV: Array<{ id: NavId; label: string; icon: typeof Search; disabled?: boolean }> = [
  { id: 'new', label: 'New chat', icon: SquarePen },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'skills', label: 'Skills', icon: Box },
  { id: 'plugins', label: 'Plugins', icon: LayoutGrid, disabled: true },
  { id: 'automations', label: 'Automations', icon: Clock },
];

function relativeAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return w < 52 ? `${w}w` : `${Math.floor(d / 365)}y`;
}

function ChatRow({
  chat,
  indented,
  selected,
  running,
  onOpen,
  onDelete,
}: {
  chat: Chat;
  indented?: boolean;
  selected: boolean;
  running?: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`${styles.chatRow} ${indented ? styles.chatIndent : ''} ${
        selected ? styles.selected : ''
      }`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      title={chat.title}
    >
      <span className={styles.chatTitle}>{chat.title}</span>
      {running ? (
        <span className={styles.runIndicator} aria-label="running" title="running">
          <SoftCells cell={1} gap={0} />
        </span>
      ) : (
        <span className={styles.age}>{relativeAge(chat.updatedAt)}</span>
      )}
      {onDelete && (
        <button
          className={styles.rowAction}
          title="Delete chat"
          aria-label="Delete chat"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Sidebar — real, SQLite-backed chat-history navigator. Projects are folders
 * the user added; chats are pi conversations grouped under their project. The
 * file tree lives in the right Inspector pane (Files tab).
 */
export function Sidebar() {
  const setView = useUiStore((s) => s.setView);
  const {
    projects,
    chatsByProject,
    expanded,
    activeChatId,
    hydrate,
    addProject,
    removeProject,
    toggleProject,
    newChat,
    openChat,
    deleteChat,
    isChatRunning,
  } = useProjectsStore();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const onNav = (id: NavId) => {
    if (id !== 'new') return; // search / skills / plugins / automations are stubs
    const target = projects[0];
    if (!target) {
      void addProject();
      return;
    }
    void newChat(target.id);
  };

  // Recent chats across all projects, newest first.
  const recent = Object.values(chatsByProject)
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);

  return (
    <aside className={styles.sidebar}>
      <nav className={styles.nav}>
        {NAV.map((n) => {
          const Icon = n.icon;
          return (
            <button
              key={n.id}
              type="button"
              className={`${styles.navItem} ${n.disabled ? styles.navDisabled : ''}`}
              onClick={() => !n.disabled && onNav(n.id)}
              disabled={n.disabled}
            >
              <Icon size={15} className={styles.navIcon} />
              <span>{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={styles.body}>
        <div className={styles.section}>
          <span>Projects</span>
          <button
            className={styles.rowAction}
            title="Add project folder"
            aria-label="Add project folder"
            type="button"
            onClick={() => void addProject()}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {projects.length === 0 && (
          <div className={`${styles.chatRow} ${styles.empty}`}>No projects — add a folder</div>
        )}

        {projects.map((p) => {
          const open = expanded.has(p.id);
          const chats = chatsByProject[p.id] ?? [];
          return (
            <div key={p.id}>
              <div
                className={styles.projectRow}
                role="button"
                tabIndex={0}
                onClick={() => void toggleProject(p.id)}
                title={p.path}
              >
                <ChevronRight
                  size={12}
                  className={`${styles.chev} ${open ? styles.chevOpen : ''}`}
                />
                <Folder size={14} className={styles.projectIcon} />
                <span className={styles.projectName}>{p.name}</span>
                <button
                  className={styles.rowAction}
                  title="New chat in this project"
                  aria-label="New chat in this project"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void newChat(p.id);
                  }}
                >
                  <SquarePen size={12} />
                </button>
                <button
                  className={styles.rowAction}
                  title="Remove project"
                  aria-label="Remove project"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeProject(p.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {open &&
                (chats.length === 0 ? (
                  <div className={`${styles.chatRow} ${styles.chatIndent} ${styles.empty}`}>
                    No chats
                  </div>
                ) : (
                  chats.map((c) => (
                    <ChatRow
                      key={c.id}
                      chat={c}
                      indented
                      selected={c.id === activeChatId}
                      running={isChatRunning(c.id)}
                      onOpen={() => void openChat(c.id)}
                      onDelete={() => void deleteChat(c.id)}
                    />
                  ))
                ))}
            </div>
          );
        })}

        {recent.length > 0 && (
          <>
            <div className={styles.section} style={{ marginTop: 10 }}>
              <span>Chats</span>
            </div>
            {recent.map((c) => (
              <ChatRow
                key={`recent-${c.id}`}
                chat={c}
                selected={c.id === activeChatId}
                running={isChatRunning(c.id)}
                onOpen={() => void openChat(c.id)}
              />
            ))}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <button
          className={styles.settingsBtn}
          title="Settings"
          type="button"
          onClick={() => setView('settings')}
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
