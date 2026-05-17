/**
 * Agent session manager + IPC bridge.
 *
 * A chat now owns its own AgentBackend runtime. Switching chats changes which
 * runtime is visible, but it does not dispose or abort the previous runtime.
 * That allows multiple chats in the same project (or different projects) to run
 * concurrently. Events from inactive runtimes are still used to persist their
 * session file and recency, but are not forwarded into the currently visible
 * renderer transcript.
 *
 * Backpressure: text_delta events arrive at LLM-streaming rates. We coalesce
 * them per-chat/per-message into a single text_delta_batch at ~16ms cadence
 * before crossing IPC; all other events pass through unmodified for the active
 * chat only.
 */

import { BrowserWindow, ipcMain } from 'electron';

import type {
  AgentBackend,
  AgentEvent,
  AgentImageContent,
  AgentState,
  PromptOptions,
  RpcLogEntry,
  ThinkingLevel,
} from '../agent/backend.js';
import { createBackend, resolveBackendConfig } from '../agent/factory.js';
import { IPC, type AppMeta, type Chat, type WireEvent } from '../shared/ipc.js';
import { chatsRepo, projectsRepo } from './db.js';

const BATCH_INTERVAL_MS = 16;
const RPC_LOG_LIMIT = 800;

interface PendingBatch {
  delta: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ChatRuntime {
  chatId: string;
  projectId: string;
  backend: AgentBackend;
  unsubscribe: () => void;
  unsubscribeRpcLogs: (() => void) | null;
  pendingBatches: Map<string, PendingBatch>;
  pendingThinking: Map<string, PendingBatch>;
}

const runtimes = new Map<string, ChatRuntime>();
let activeChatId: string | null = null;
let rpcLogs: RpcLogEntry[] = [];

const EMPTY_STATE: AgentState = {
  runState: 'idle',
  modelProvider: 'none',
  modelId: '—',
  thinkingLevel: 'medium',
  tokensUsed: 0,
  tokensMax: 200_000,
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  contextPercent: 0,
  autoCompactionEnabled: true,
  sessionId: 'none',
};

function sendToAllRenderers(event: WireEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.Event, event);
  }
}

function sendToAllRenderersIfActive(runtime: ChatRuntime, event: WireEvent): void {
  if (runtime.chatId === activeChatId) sendToAllRenderers(event);
}

function sendRpcLogToAllRenderers(entry: RpcLogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.RpcLogEvent, entry);
  }
}

function recordRpcLog(entry: RpcLogEntry): void {
  rpcLogs.push(entry);
  if (rpcLogs.length > RPC_LOG_LIMIT) rpcLogs = rpcLogs.slice(-RPC_LOG_LIMIT);
  sendRpcLogToAllRenderers(entry);
}

function flushBatch(runtime: ChatRuntime, messageId: string): void {
  const pending = runtime.pendingBatches.get(messageId);
  if (!pending) return;
  if (pending.delta.length > 0) {
    sendToAllRenderersIfActive(runtime, {
      type: 'text_delta_batch',
      messageId,
      delta: pending.delta,
    });
  }
  pending.delta = '';
  pending.timer = null;
}

function flushThinkingBatch(runtime: ChatRuntime, messageId: string): void {
  const pending = runtime.pendingThinking.get(messageId);
  if (!pending) return;
  if (pending.delta.length > 0) {
    sendToAllRenderersIfActive(runtime, {
      type: 'thinking_delta_batch',
      messageId,
      delta: pending.delta,
    });
  }
  pending.delta = '';
  pending.timer = null;
}

function clearPending(runtime: ChatRuntime): void {
  for (const pending of runtime.pendingBatches.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  runtime.pendingBatches.clear();
  for (const pending of runtime.pendingThinking.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  runtime.pendingThinking.clear();
}

function dispatchEvent(runtime: ChatRuntime, event: AgentEvent): void {
  if (event.type === 'text_delta') {
    const messageId = event.messageId;
    let pending = runtime.pendingBatches.get(messageId);
    if (!pending) {
      pending = { delta: '', timer: null };
      runtime.pendingBatches.set(messageId, pending);
    }
    pending.delta += event.delta;
    if (pending.timer === null) {
      pending.timer = setTimeout(() => flushBatch(runtime, messageId), BATCH_INTERVAL_MS);
    }
    return;
  }

  if (event.type === 'thinking_delta') {
    const messageId = event.messageId;
    let pending = runtime.pendingThinking.get(messageId);
    if (!pending) {
      pending = { delta: '', timer: null };
      runtime.pendingThinking.set(messageId, pending);
    }
    pending.delta += event.delta;
    if (pending.timer === null) {
      pending.timer = setTimeout(() => flushThinkingBatch(runtime, messageId), BATCH_INTERVAL_MS);
    }
    return;
  }

  if (event.type === 'message_end') {
    flushBatch(runtime, event.messageId);
    runtime.pendingBatches.delete(event.messageId);
    flushThinkingBatch(runtime, event.messageId);
    runtime.pendingThinking.delete(event.messageId);
  }

  sendToAllRenderersIfActive(runtime, event);

  // When any run finishes (active or inactive), persist its pi session file so
  // the chat can be resumed later, and bump its recency for sidebar ordering.
  if (event.type === 'agent_end') {
    const chatId = runtime.chatId;
    void runtime.backend.getSessionFile().then((file) => {
      if (file) chatsRepo.setSessionFile(chatId, file);
      else chatsRepo.touch(chatId);
    });
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'New chat';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

async function disposeRuntime(runtime: ChatRuntime): Promise<void> {
  runtime.unsubscribe();
  runtime.unsubscribeRpcLogs?.();
  clearPending(runtime);
  await runtime.backend.dispose();
}

async function disposeAllRuntimes(): Promise<void> {
  const toDispose = [...runtimes.values()];
  runtimes.clear();
  activeChatId = null;
  await Promise.allSettled(toDispose.map((runtime) => disposeRuntime(runtime)));
}

/**
 * Make `chatId` the visible conversation. Spawns a backend rooted at the chat's
 * project folder if this chat does not already have a runtime. Existing
 * runtimes keep running when another chat becomes active.
 */
async function openChat(chatId: string): Promise<Chat> {
  const chat = chatsRepo.get(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);
  const project = projectsRepo.get(chat.projectId);
  if (!project) throw new Error(`Project not found for chat: ${chatId}`);

  const existing = runtimes.get(chatId);
  if (existing) {
    activeChatId = chatId;
    projectsRepo.touch(project.id);
    chatsRepo.touch(chat.id);
    return chatsRepo.get(chatId) ?? chat;
  }

  const config = resolveBackendConfig(process.env, project.path);
  const created = await createBackend(config);
  let runtime: ChatRuntime | null = null;
  const unsubscribe = created.subscribe((event) => {
    if (runtime) dispatchEvent(runtime, event);
  });
  const unsubscribeRpcLogs = created.subscribeRpcLogs?.(recordRpcLog) ?? null;
  runtime = {
    chatId,
    projectId: project.id,
    backend: created,
    unsubscribe,
    unsubscribeRpcLogs,
    pendingBatches: new Map(),
    pendingThinking: new Map(),
  };
  runtimes.set(chatId, runtime);

  try {
    if (chat.sessionFile) {
      await created.switchSession(chat.sessionFile);
    }
  } catch (err) {
    runtimes.delete(chatId);
    await disposeRuntime(runtime);
    throw err;
  }

  activeChatId = chatId;
  projectsRepo.touch(project.id);
  chatsRepo.touch(chat.id);
  return chatsRepo.get(chatId) ?? chat;
}

function activeRuntime(): ChatRuntime | null {
  return activeChatId ? (runtimes.get(activeChatId) ?? null) : null;
}

function requireRuntime(): ChatRuntime {
  const runtime = activeRuntime();
  if (!runtime) {
    throw new Error('No active chat. Open or create a chat first.');
  }
  return runtime;
}

export const backendMeta = {
  kind: (process.env.PI_BACKEND ?? 'rpc-local') as AppMeta['backend'],
  version: '0.1.0',
};

export function installAgentBridge(): void {
  ipcMain.handle(IPC.ChatOpen, async (_e, chatId: string) => openChat(chatId));

  ipcMain.handle(IPC.Prompt, async (_e, text: string, options?: PromptOptions) => {
    const runtime = requireRuntime();
    const chat = chatsRepo.get(runtime.chatId);
    if (chat && (chat.title === 'New chat' || chat.title.trim() === '')) {
      chatsRepo.rename(chat.id, deriveTitle(text));
    }
    await runtime.backend.prompt(text, options);
  });
  ipcMain.handle(IPC.Steer, async (_e, text: string, images?: AgentImageContent[]) => {
    await requireRuntime().backend.steer(text, images);
  });
  ipcMain.handle(IPC.FollowUp, async (_e, text: string, images?: AgentImageContent[]) => {
    await requireRuntime().backend.followUp(text, images);
  });
  ipcMain.handle(IPC.Abort, async () => {
    await requireRuntime().backend.abort();
  });
  ipcMain.handle(IPC.GetState, async () => activeRuntime()?.backend.getState() ?? EMPTY_STATE);
  ipcMain.handle(IPC.GetMessages, async () => activeRuntime()?.backend.getMessages() ?? []);
  ipcMain.handle(IPC.Models, async () => activeRuntime()?.backend.getAvailableModels() ?? []);
  ipcMain.handle(IPC.SetModel, async (_e, provider: string, modelId: string) => {
    await requireRuntime().backend.setModel(provider, modelId);
  });
  ipcMain.handle(IPC.SetThinkingLevel, async (_e, level: ThinkingLevel) => {
    await requireRuntime().backend.setThinkingLevel(level);
  });
  ipcMain.handle(IPC.NewSession, async () => {
    await requireRuntime().backend.newSession();
  });
  ipcMain.handle(IPC.SwitchSession, async (_e, path: string) => {
    await requireRuntime().backend.switchSession(path);
  });
  ipcMain.handle(IPC.Fork, async (_e, entryId: string) => {
    await requireRuntime().backend.fork(entryId);
  });

  ipcMain.handle(
    IPC.Meta,
    async (): Promise<AppMeta> => ({
      backend: backendMeta.kind,
      version: backendMeta.version,
      platform: process.platform as AppMeta['platform'],
    }),
  );

  ipcMain.handle(IPC.RpcLogsGet, async (): Promise<RpcLogEntry[]> => rpcLogs.slice());
  ipcMain.handle(IPC.RpcLogsClear, async (): Promise<void> => {
    rpcLogs = [];
  });
}

export async function disposeAgentBridge(): Promise<void> {
  await disposeAllRuntimes();
}
