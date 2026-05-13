/**
 * Wires the AgentBackend into Electron IPC.
 *
 * Backpressure: text_delta events arrive at LLM-streaming rates (often many per
 * 16ms). Forwarding each one across IPC plus a React reconciliation is what
 * locks up renderers under sustained streams (§viii). We coalesce text_delta
 * events per-message into a single text_delta_batch at ~16ms cadence before
 * sending. All other events pass through unmodified.
 */

import { BrowserWindow, ipcMain } from 'electron';

import type {
  AgentBackend,
  AgentEvent,
  PromptOptions,
  ThinkingLevel,
} from '../agent/backend.js';
import { createBackend, resolveBackendConfig } from '../agent/factory.js';
import { IPC, type AppMeta, type WireEvent } from '../shared/ipc.js';

const BATCH_INTERVAL_MS = 16;

let backend: AgentBackend | null = null;
let unsubscribe: (() => void) | null = null;

interface PendingBatch {
  delta: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingBatches = new Map<string, PendingBatch>();

function sendToAllRenderers(event: WireEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.Event, event);
    }
  }
}

function flushBatch(messageId: string): void {
  const pending = pendingBatches.get(messageId);
  if (!pending) return;
  if (pending.delta.length > 0) {
    sendToAllRenderers({
      type: 'text_delta_batch',
      messageId,
      delta: pending.delta,
    });
  }
  pending.delta = '';
  pending.timer = null;
}

function dispatchEvent(event: AgentEvent): void {
  if (event.type === 'text_delta') {
    const messageId = event.messageId;
    let pending = pendingBatches.get(messageId);
    if (!pending) {
      pending = { delta: '', timer: null };
      pendingBatches.set(messageId, pending);
    }
    pending.delta += event.delta;
    if (pending.timer === null) {
      pending.timer = setTimeout(() => flushBatch(messageId), BATCH_INTERVAL_MS);
    }
    return;
  }

  if (event.type === 'message_end') {
    // Drain any pending text before the close so the renderer never sees a
    // message_end ahead of its last delta.
    flushBatch(event.messageId);
    pendingBatches.delete(event.messageId);
  }

  sendToAllRenderers(event);
}

/** Resolve which backend to load and stash a tiny diagnostic for the renderer footer. */
export const backendMeta = {
  kind: 'mock' as 'mock' | 'sdk-local' | 'rpc-local' | 'rpc-ssh',
  version: '0.1.0',
};

export async function installAgentBridge(): Promise<void> {
  const config = resolveBackendConfig(process.env, process.cwd());
  backendMeta.kind = config.kind;
  backend = await createBackend(config);
  unsubscribe = backend.subscribe(dispatchEvent);

  ipcMain.handle(IPC.Prompt, async (_e, text: string, options?: PromptOptions) => {
    await backend!.prompt(text, options);
  });
  ipcMain.handle(IPC.Steer, async (_e, text: string) => {
    await backend!.steer(text);
  });
  ipcMain.handle(IPC.FollowUp, async (_e, text: string) => {
    await backend!.followUp(text);
  });
  ipcMain.handle(IPC.Abort, async () => {
    await backend!.abort();
  });
  ipcMain.handle(IPC.GetState, async () => backend!.getState());
  ipcMain.handle(IPC.GetMessages, async () => backend!.getMessages());
  ipcMain.handle(IPC.SetModel, async (_e, provider: string, modelId: string) => {
    await backend!.setModel(provider, modelId);
  });
  ipcMain.handle(IPC.SetThinkingLevel, async (_e, level: ThinkingLevel) => {
    await backend!.setThinkingLevel(level);
  });
  ipcMain.handle(IPC.NewSession, async () => {
    await backend!.newSession();
  });
  ipcMain.handle(IPC.SwitchSession, async (_e, path: string) => {
    await backend!.switchSession(path);
  });
  ipcMain.handle(IPC.Fork, async (_e, entryId: string) => {
    await backend!.fork(entryId);
  });

  ipcMain.handle(IPC.Meta, async (): Promise<AppMeta> => ({
    backend: backendMeta.kind,
    version: backendMeta.version,
    platform: process.platform as AppMeta['platform'],
  }));
}

export async function disposeAgentBridge(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const messageId of pendingBatches.keys()) {
    flushBatch(messageId);
  }
  pendingBatches.clear();
  if (backend) {
    await backend.dispose();
    backend = null;
  }
}
