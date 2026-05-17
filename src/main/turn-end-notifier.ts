import { app, BrowserWindow, Notification, shell } from 'electron';

import { PREFS_DEFAULTS, type PrefsShape } from '../shared/ipc.js';
import { readPrefs } from './prefs-bridge.js';
import {
  decideTurnEndNotification,
  type TurnEndNotificationDecision,
} from './turn-end-notifier-policy.js';

const liveNotifications = new Set<Notification>();

export interface TurnEndNotificationRequest {
  chatTitle: string | null;
  isActiveChat: boolean;
  runStartedAt: number | null;
  suppressNextCompletionNotify: boolean;
  lastNotificationAt: number | null;
}

export interface TurnEndNotificationResult {
  decision: TurnEndNotificationDecision;
  notifiedAt: number | null;
}

function windows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

function focusPiWindow(): void {
  const win = BrowserWindow.getFocusedWindow() ?? windows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function requestAttention(): void {
  if (process.platform === 'darwin') {
    app.dock.bounce('informational');
    return;
  }

  for (const win of windows()) {
    win.flashFrame(true);
    win.once('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  }
}

function notificationBody(chatTitle: string | null): string {
  const title = chatTitle?.trim();
  if (title && title !== 'New chat') {
    const shortened = title.length > 72 ? `${title.slice(0, 72)}…` : title;
    return `Finished “${shortened}”.`;
  }
  return 'Finished responding.';
}

function showToast(chatTitle: string | null): void {
  const notification = new Notification({
    title: 'Pi is ready',
    body: notificationBody(chatTitle),
    silent: true,
  });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.once('close', release);
  notification.once('failed', release);
  notification.on('click', focusPiWindow);
  notification.show();
}

async function prefsForNotification(): Promise<PrefsShape> {
  try {
    return await readPrefs();
  } catch {
    return PREFS_DEFAULTS;
  }
}

export async function notifyTurnEnd({
  chatTitle,
  isActiveChat,
  runStartedAt,
  suppressNextCompletionNotify,
  lastNotificationAt,
}: TurnEndNotificationRequest): Promise<TurnEndNotificationResult> {
  const prefs = await prefsForNotification();
  const now = Date.now();
  const decision = decideTurnEndNotification({
    prefs,
    now,
    appFocused: windows().some((win) => win.isFocused()),
    isActiveChat,
    runStartedAt,
    suppressNextCompletionNotify,
    lastNotificationAt,
    toastSupported: Notification.isSupported(),
  });

  if (!decision.shouldNotify) return { decision, notifiedAt: null };

  if (decision.sound) shell.beep();
  if (decision.attention) requestAttention();
  if (decision.toast) showToast(chatTitle);

  return { decision, notifiedAt: now };
}
