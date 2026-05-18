/**
 * Projects + chats store — the real, SQLite-backed sidebar data.
 *
 * Replaces the hardcoded mock dataset. Projects are folders the user added;
 * chats are pi conversations within a project. Opening a chat asks the main
 * process to (re)spawn the pi agent in that project's folder and resume the
 * chat's session, then reloads the transcript into the agent store.
 */

import { create } from 'zustand';
import { piClient } from '../client/pi-client.js';
import type { Chat, ChatRuntimeStatus, Project } from '../../shared/ipc.js';
import { useAgentStore } from './agent.js';
import { useUiStore } from './ui.js';

/** Install once: finished runs may auto-title/touch chats in main, so
 *  refresh affected project chat lists as background runtimes complete. */
let agentSubInstalled = false;

interface ProjectsState {
  projects: Project[];
  chatsByProject: Record<string, Chat[]>;
  expanded: Set<string>;
  activeProjectId: string | null;
  activeChatId: string | null;
  runtimeByChat: Record<string, ChatRuntimeStatus>;
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
  isChatRunning(id: string): boolean;
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
  runtimeByChat: {},
  loading: false,

  async hydrate() {
    if (!agentSubInstalled) {
      agentSubInstalled = true;
      piClient.subscribeAll((envelope) => {
        if (envelope.event.type === 'agent_end') {
          void get().loadChats(envelope.projectId);
        }
      });
      piClient.runtimes.subscribe((status) => {
        set((s) => ({ runtimeByChat: { ...s.runtimeByChat, [status.chatId]: status } }));
        const pid = get().activeProjectId;
        if (status.runState === 'idle' && pid) void get().loadChats(pid);
      });
    }
    set({ loading: true });
    try {
      const [projects, runtimeStatuses] = await Promise.all([
        piClient.projects.list(),
        piClient.runtimes.list(),
      ]);
      set({
        projects,
        runtimeByChat: Object.fromEntries(runtimeStatuses.map((status) => [status.chatId, status])),
      });
      // Eagerly load chats for every project so the grouped sidebar is
      // populated without a per-row click.
      await Promise.all(projects.map((p) => get().loadChats(p.id)));
    } finally {
      set({ loading: false });
    }
  },

  async addProject() {
    const picked = await piClient.projects.pick();
    if (!picked) return;
    const project = await piClient.projects.add(picked.path, picked.name);
    const projects = await piClient.projects.list();
    set((s) => ({
      projects,
      expanded: new Set(s.expanded).add(project.id),
    }));
    await get().loadChats(project.id);
  },

  async removeProject(id) {
    const running = (get().chatsByProject[id] ?? []).filter((chat) => get().isChatRunning(chat.id));
    if (
      running.length > 0 &&
      !window.confirm(
        `This project has ${running.length} running chat${running.length === 1 ? '' : 's'}. Remove it and abort those runtimes?`,
      )
    ) {
      return;
    }
    await piClient.projects.remove(id);
    set((s) => {
      const chatsByProject = { ...s.chatsByProject };
      delete chatsByProject[id];
      return {
        projects: s.projects.filter((p) => p.id !== id),
        chatsByProject,
        runtimeByChat: Object.fromEntries(
          Object.entries(s.runtimeByChat).filter(([, status]) => status.projectId !== id),
        ),
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
    const chats = await piClient.chats.list(projectId);
    set((s) => ({ chatsByProject: { ...s.chatsByProject, [projectId]: chats } }));
  },

  async newChat(projectId) {
    const chat = await piClient.chats.create(projectId);
    await get().loadChats(projectId);
    await get().openChat(chat.id);
  },

  async openChat(chatId) {
    const chat = await piClient.chats.open(chatId);
    set({ activeChatId: chat.id, activeProjectId: chat.projectId });
    useUiStore.getState().setView('chat');
    await useAgentStore.getState().loadActiveChat(chat.id);
    // Recency may have changed (main touches updated_at) — refresh the group.
    await get().loadChats(chat.projectId);
  },

  async renameChat(id, title) {
    await piClient.chats.rename(id, title);
    const projectId = get().activeProjectId;
    if (projectId) await get().loadChats(projectId);
  },

  async deleteChat(id) {
    if (
      get().isChatRunning(id) &&
      !window.confirm('This chat is still running. Delete it and abort its runtime?')
    ) {
      return;
    }
    await piClient.chats.delete(id);
    set((s) => {
      const next: Record<string, Chat[]> = {};
      for (const [pid, list] of Object.entries(s.chatsByProject)) {
        next[pid] = list.filter((c) => c.id !== id);
      }
      return {
        chatsByProject: next,
        activeChatId: s.activeChatId === id ? null : s.activeChatId,
        runtimeByChat: Object.fromEntries(
          Object.entries(s.runtimeByChat).filter(([chatId]) => chatId !== id),
        ),
      };
    });
  },

  isChatRunning(id) {
    const status = get().runtimeByChat[id];
    return !!status?.hasRuntime && status.runState !== 'idle';
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
