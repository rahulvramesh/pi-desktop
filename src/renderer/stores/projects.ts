/**
 * Projects + chats store — the real, SQLite-backed sidebar data.
 *
 * Replaces the hardcoded mock dataset. Projects are folders the user added;
 * chats are pi conversations within a project. Opening a chat asks the main
 * process to (re)spawn the pi agent in that project's folder and resume the
 * chat's session, then reloads the transcript into the agent store.
 */

import { create } from 'zustand';
import type { Chat, Project } from '../../shared/ipc.js';
import { useAgentStore } from './agent.js';
import { useUiStore } from './ui.js';

/** Install once: a finished run may have auto-titled the chat in main, so
 *  refresh the active project's chats to surface the new title live. */
let agentSubInstalled = false;

interface ProjectsState {
  projects: Project[];
  chatsByProject: Record<string, Chat[]>;
  expanded: Set<string>;
  activeProjectId: string | null;
  activeChatId: string | null;
  loading: boolean;

  hydrate(): Promise<void>;
  addProject(): Promise<void>;
  removeProject(id: string): Promise<void>;
  toggleProject(id: string): Promise<void>;
  loadChats(projectId: string): Promise<void>;
  newChat(projectId: string): Promise<void>;
  openChat(chatId: string): Promise<void>;
  renameChat(id: string, title: string): Promise<void>;
  deleteChat(id: string): Promise<void>;
  activeProjectPath(): string | null;
  activeProject(): Project | null;
  activeChat(): Chat | null;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  chatsByProject: {},
  expanded: new Set(),
  activeProjectId: null,
  activeChatId: null,
  loading: false,

  async hydrate() {
    if (!agentSubInstalled) {
      agentSubInstalled = true;
      window.pi.subscribe((ev) => {
        if (ev.type === 'agent_end') {
          const pid = get().activeProjectId;
          if (pid) void get().loadChats(pid);
        }
      });
    }
    set({ loading: true });
    try {
      const projects = await window.pi.projects.list();
      set({ projects });
      // Eagerly load chats for every project so the grouped sidebar is
      // populated without a per-row click.
      await Promise.all(projects.map((p) => get().loadChats(p.id)));
    } finally {
      set({ loading: false });
    }
  },

  async addProject() {
    const picked = await window.pi.projects.pick();
    if (!picked) return;
    const project = await window.pi.projects.add(picked.path, picked.name);
    const projects = await window.pi.projects.list();
    set((s) => ({
      projects,
      expanded: new Set(s.expanded).add(project.id),
    }));
    await get().loadChats(project.id);
  },

  async removeProject(id) {
    await window.pi.projects.remove(id);
    set((s) => {
      const chatsByProject = { ...s.chatsByProject };
      delete chatsByProject[id];
      return {
        projects: s.projects.filter((p) => p.id !== id),
        chatsByProject,
      };
    });
  },

  async toggleProject(id) {
    const expanded = new Set(get().expanded);
    if (expanded.has(id)) expanded.delete(id);
    else {
      expanded.add(id);
      await get().loadChats(id);
    }
    set({ expanded });
  },

  async loadChats(projectId) {
    const chats = await window.pi.chats.list(projectId);
    set((s) => ({ chatsByProject: { ...s.chatsByProject, [projectId]: chats } }));
  },

  async newChat(projectId) {
    const chat = await window.pi.chats.create(projectId);
    await get().loadChats(projectId);
    await get().openChat(chat.id);
  },

  async openChat(chatId) {
    const chat = await window.pi.chats.open(chatId);
    set({ activeChatId: chat.id, activeProjectId: chat.projectId });
    useUiStore.getState().setView('chat');
    await useAgentStore.getState().loadActiveChat();
    // Recency may have changed (main touches updated_at) — refresh the group.
    await get().loadChats(chat.projectId);
  },

  async renameChat(id, title) {
    await window.pi.chats.rename(id, title);
    const projectId = get().activeProjectId;
    if (projectId) await get().loadChats(projectId);
  },

  async deleteChat(id) {
    await window.pi.chats.delete(id);
    set((s) => {
      const next: Record<string, Chat[]> = {};
      for (const [pid, list] of Object.entries(s.chatsByProject)) {
        next[pid] = list.filter((c) => c.id !== id);
      }
      return {
        chatsByProject: next,
        activeChatId: s.activeChatId === id ? null : s.activeChatId,
      };
    });
  },

  activeProjectPath() {
    return get().activeProject()?.path ?? null;
  },

  activeProject() {
    const { activeProjectId, projects } = get();
    return projects.find((p) => p.id === activeProjectId) ?? null;
  },

  activeChat() {
    const { activeChatId, chatsByProject } = get();
    if (!activeChatId) return null;
    for (const list of Object.values(chatsByProject)) {
      const c = list.find((x) => x.id === activeChatId);
      if (c) return c;
    }
    return null;
  },
}));
