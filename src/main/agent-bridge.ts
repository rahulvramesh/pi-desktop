/**
 * Agent session manager + IPC bridge.
 *
 * A chat now owns its own AgentBackend runtime. Switching chats changes which
 * runtime is visible, but it does not dispose or abort the previous runtime.
 * That allows multiple chats in the same project (or different projects) to run
 * concurrently. Events are emitted both through the legacy active-chat stream
 * and through chat-scoped envelopes so the renderer can track background runs.
 *
 * Backpressure: text_delta events arrive at LLM-streaming rates. We coalesce
 * them per-chat/per-message into a single text_delta_batch at ~16ms cadence
 * before crossing IPC; all other events pass through unmodified.
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
import { shutdownRuntimeProxy } from '../agent/proxy-process.js';
import {
  IPC,
  type AppMeta,
  type Chat,
  type ChatRuntimeStatus,
  type WireEvent,
  type WireEventEnvelope,
} from '../shared/ipc.js';
import { chatsRepo, projectsRepo } from './db.js';
import { notifyTurnEnd } from './turn-end-notifier.js';

const BATCH_INTERVAL_MS = 16;
const RPC_LOG_LIMIT = 800;
const DEFAULT_IDLE_RUNTIME_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_WARM_IDLE_RUNTIMES = 6;
const RUNTIME_CLEANUP_INTERVAL_MS = 60 * 1000;

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
  runState: AgentState['runState'];
  statusUpdatedAt: number;
  eventSeq: number;
  idleSince: number;
  lastUsedAt: number;
  runStartedAt: number | null;
  suppressNextCompletionNotify: boolean;
  lastNotificationAt: number | null;
}

const runtimes = new Map<string, ChatRuntime>();
let activeChatId: string | null = null;
let rpcLogs: RpcLogEntry[] = [];
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

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

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function idleRuntimeTtlMs(): number {
  return numberFromEnv('PI_RUNTIME_IDLE_TTL_MS', DEFAULT_IDLE_RUNTIME_TTL_MS);
}

function maxWarmIdleRuntimes(): number {
  return numberFromEnv('PI_RUNTIME_MAX_WARM_IDLE', DEFAULT_MAX_WARM_IDLE_RUNTIMES);
}

function sendToAllRenderers(event: WireEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.Event, event);
  }
}

function sendEnvelopeToAllRenderers(envelope: WireEventEnvelope): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.EventEnvelope, envelope);
  }
}

function sendRuntimeEvent(runtime: ChatRuntime, event: WireEvent): void {
  runtime.lastUsedAt = Date.now();
  runtime.eventSeq += 1;
  sendEnvelopeToAllRenderers({
    chatId: runtime.chatId,
    projectId: runtime.projectId,
    seq: runtime.eventSeq,
    timestamp: runtime.lastUsedAt,
    event,
  });
  if (runtime.chatId === activeChatId) sendToAllRenderers(event);
}

function sendRpcLogToAllRenderers(entry: RpcLogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.RpcLogEvent, entry);
  }
}

function runtimeStatus(runtime: ChatRuntime): ChatRuntimeStatus {
  return {
    chatId: runtime.chatId,
    projectId: runtime.projectId,
    runState: runtime.runState,
    active: runtime.chatId === activeChatId,
    hasRuntime: true,
    updatedAt: runtime.statusUpdatedAt,
  };
}

function sendRuntimeStatusToAllRenderers(status: ChatRuntimeStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.RuntimeStatusEvent, status);
  }
}

function broadcastRuntimeStatus(runtime: ChatRuntime): void {
  runtime.statusUpdatedAt = Date.now();
  sendRuntimeStatusToAllRenderers(runtimeStatus(runtime));
}

function broadcastAllRuntimeStatuses(): void {
  for (const runtime of runtimes.values()) sendRuntimeStatusToAllRenderers(runtimeStatus(runtime));
}

function recordRpcLog(entry: RpcLogEntry): void {
  rpcLogs.push(entry);
  if (rpcLogs.length > RPC_LOG_LIMIT) rpcLogs = rpcLogs.slice(-RPC_LOG_LIMIT);
  sendRpcLogToAllRenderers(entry);
}

function flushBatch(runtime: ChatRuntime, messageId: string): void {
  const pending = runtime.pendingBatches.get(messageId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.delta.length > 0) {
    sendRuntimeEvent(runtime, {
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
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.delta.length > 0) {
    sendRuntimeEvent(runtime, {
      type: 'thinking_delta_batch',
      messageId,
      delta: pending.delta,
    });
  }
  pending.delta = '';
  pending.timer = null;
}

function flushAllPending(runtime: ChatRuntime): void {
  for (const messageId of Array.from(runtime.pendingBatches.keys())) flushBatch(runtime, messageId);
  for (const messageId of Array.from(runtime.pendingThinking.keys())) {
    flushThinkingBatch(runtime, messageId);
  }
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
  if (event.type === 'agent_start') {
    runtime.runState = 'thinking';
    runtime.idleSince = 0;
    runtime.lastUsedAt = Date.now();
    runtime.runStartedAt = Date.now();
    runtime.suppressNextCompletionNotify = false;
    broadcastRuntimeStatus(runtime);
  } else if (event.type === 'agent_end') {
    runtime.runState = 'idle';
    runtime.idleSince = Date.now();
    broadcastRuntimeStatus(runtime);
  } else if (event.type === 'state_changed') {
    runtime.runState = event.state.runState;
    runtime.idleSince = event.state.runState === 'idle' ? Date.now() : 0;
    broadcastRuntimeStatus(runtime);
  } else if (event.type === 'tool_execution_start') {
    if (runtime.runState !== 'running') {
      runtime.runState = 'running';
      runtime.idleSince = 0;
      broadcastRuntimeStatus(runtime);
    }
  }

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

  sendRuntimeEvent(runtime, event);

  // When any run finishes (active or inactive), persist its pi session file so
  // the chat can be resumed later, and bump its recency for sidebar ordering.
  if (event.type === 'agent_end') {
    const chatId = runtime.chatId;
    const notificationRunStartedAt = runtime.runStartedAt;
    const notificationSuppressed = runtime.suppressNextCompletionNotify;
    const notificationLastShownAt = runtime.lastNotificationAt;
    const isActiveChat = runtime.chatId === activeChatId;
    const chatTitle = chatsRepo.get(chatId)?.title ?? null;
    runtime.runStartedAt = null;
    runtime.suppressNextCompletionNotify = false;

    void runtime.backend.getSessionFile().then((file) => {
      if (file) chatsRepo.setSessionFile(chatId, file);
      else chatsRepo.touch(chatId);
    });

    void notifyTurnEnd({
      chatTitle,
      isActiveChat,
      runStartedAt: notificationRunStartedAt,
      suppressNextCompletionNotify: notificationSuppressed,
      lastNotificationAt: notificationLastShownAt,
    })
      .then((result) => {
        if (result.notifiedAt !== null) runtime.lastNotificationAt = result.notifiedAt;
      })
      .catch(() => {
        // Native notifications are best-effort and should never break streaming.
      });

    pruneIdleRuntimes();
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'New chat';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

async function disposeRuntime(runtime: ChatRuntime): Promise<void> {
  runtime.runState = 'idle';
  runtime.statusUpdatedAt = Date.now();
  sendRuntimeStatusToAllRenderers({ ...runtimeStatus(runtime), hasRuntime: false, active: false });
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

function idleInactiveRuntimes(now = Date.now()): ChatRuntime[] {
  return [...runtimes.values()]
    .filter(
      (runtime) =>
        runtime.chatId !== activeChatId && runtime.runState === 'idle' && runtime.idleSince > 0,
    )
    .sort((a, b) => (a.idleSince || now) - (b.idleSince || now));
}

function pruneIdleRuntimes(): void {
  const ttl = idleRuntimeTtlMs();
  const maxWarmIdle = maxWarmIdleRuntimes();
  if (ttl === 0 && maxWarmIdle === 0) return;

  const now = Date.now();
  const candidates = idleInactiveRuntimes(now);
  const selected = new Set<ChatRuntime>();

  if (ttl > 0) {
    for (const runtime of candidates) {
      if (now - runtime.idleSince >= ttl) selected.add(runtime);
    }
  }

  if (maxWarmIdle > 0 && candidates.length > maxWarmIdle) {
    for (const runtime of candidates.slice(0, candidates.length - maxWarmIdle)) {
      selected.add(runtime);
    }
  }

  for (const runtime of selected) {
    if (!runtimes.delete(runtime.chatId)) continue;
    void disposeRuntime(runtime).catch(() => {
      // Cleanup is best-effort; an explicit close/delete path will retry.
    });
  }
}

function startRuntimeCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(pruneIdleRuntimes, RUNTIME_CLEANUP_INTERVAL_MS);
  (cleanupTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}

function stopRuntimeCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
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
    existing.lastUsedAt = Date.now();
    existing.statusUpdatedAt = Date.now();
    projectsRepo.touch(project.id);
    chatsRepo.touch(chat.id);
    broadcastAllRuntimeStatuses();
    pruneIdleRuntimes();
    return chatsRepo.get(chatId) ?? chat;
  }

  const config = resolveBackendConfig(process.env, project.path, {
    chatId,
    projectId: project.id,
    title: chat.title,
  });
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
    runState: 'idle',
    statusUpdatedAt: Date.now(),
    eventSeq: 0,
    idleSince: Date.now(),
    lastUsedAt: Date.now(),
    runStartedAt: null,
    suppressNextCompletionNotify: false,
    lastNotificationAt: null,
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
  broadcastAllRuntimeStatuses();
  pruneIdleRuntimes();
  return chatsRepo.get(chatId) ?? chat;
}

function activeRuntime(): ChatRuntime | null {
  if (activeChatId) {
    const runtime = runtimes.get(activeChatId);
    if (runtime) return runtime;
  }
  // Defensive recovery for renderer/main races during startup or reload: if
  // there is exactly one warm runtime, it is the only possible command target.
  if (runtimes.size === 1) {
    const runtime = [...runtimes.values()][0];
    if (runtime) {
      activeChatId = runtime.chatId;
      broadcastRuntimeStatus(runtime);
      return runtime;
    }
  }
  return null;
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
  startRuntimeCleanup();
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
    const runtime = requireRuntime();
    runtime.suppressNextCompletionNotify = true;
    await runtime.backend.abort();
  });
  ipcMain.handle(IPC.GetState, async () => activeRuntime()?.backend.getState() ?? EMPTY_STATE);
  ipcMain.handle(IPC.GetMessages, async () => {
    const runtime = activeRuntime();
    if (!runtime) return [];
    // Avoid duplicate text when switching back to a streaming chat: first flush
    // any IPC-coalesced deltas, then reconcile with backend history.
    flushAllPending(runtime);
    return runtime.backend.getMessages();
  });
  ipcMain.handle(IPC.RuntimeStatusesGet, async (): Promise<ChatRuntimeStatus[]> =>
    [...runtimes.values()].map(runtimeStatus),
  );
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

export async function disposeChatRuntime(chatId: string): Promise<void> {
  const runtime = runtimes.get(chatId);
  if (!runtime) return;
  runtimes.delete(chatId);
  if (activeChatId === chatId) activeChatId = null;
  await disposeRuntime(runtime);
  broadcastAllRuntimeStatuses();
}

export async function disposeProjectRuntimes(projectId: string): Promise<void> {
  const matching = [...runtimes.values()].filter((runtime) => runtime.projectId === projectId);
  for (const runtime of matching) {
    runtimes.delete(runtime.chatId);
    if (activeChatId === runtime.chatId) activeChatId = null;
  }
  await Promise.allSettled(matching.map((runtime) => disposeRuntime(runtime)));
  broadcastAllRuntimeStatuses();
}

export async function disposeAgentBridge(): Promise<void> {
  stopRuntimeCleanup();
  await disposeAllRuntimes();
  await shutdownRuntimeProxy();
}
