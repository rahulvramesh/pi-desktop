import type { PrefsShape } from '../shared/ipc.js';

export const TURN_END_NOTIFICATION_DEBOUNCE_MS = 1_500;

export type TurnEndNotificationPrefs = Pick<
  PrefsShape,
  | 'turnEndNotifyEnabled'
  | 'turnEndNotifySound'
  | 'turnEndNotifyToast'
  | 'turnEndNotifyAttention'
  | 'turnEndNotifyOnlyWhenUnfocused'
>;

export interface TurnEndNotificationDecisionInput {
  prefs: TurnEndNotificationPrefs;
  /** Current timestamp; injected so tests do not depend on wall-clock time. */
  now: number;
  /** Whether the Electron app is focused. */
  appFocused: boolean;
  /** Whether the chat that just ended is the chat visible in the focused window. */
  isActiveChat: boolean;
  /** Set on agent_start; null means this agent_end was not paired with a run. */
  runStartedAt: number | null;
  /** Set by explicit abort so an abort-induced agent_end stays quiet. */
  suppressNextCompletionNotify: boolean;
  /** Last time this runtime notified, for duplicate agent_end protection. */
  lastNotificationAt: number | null;
  /** Native toast support varies by OS/session. Other channels may still fire. */
  toastSupported: boolean;
}

export type TurnEndNotificationSkipReason =
  | 'disabled'
  | 'no-run'
  | 'aborted'
  | 'already-visible'
  | 'debounced'
  | 'no-channel';

export interface TurnEndNotificationDecision {
  shouldNotify: boolean;
  sound: boolean;
  toast: boolean;
  attention: boolean;
  reason?: TurnEndNotificationSkipReason;
}

function skip(reason: TurnEndNotificationSkipReason): TurnEndNotificationDecision {
  return { shouldNotify: false, sound: false, toast: false, attention: false, reason };
}

export function decideTurnEndNotification({
  prefs,
  now,
  appFocused,
  isActiveChat,
  runStartedAt,
  suppressNextCompletionNotify,
  lastNotificationAt,
  toastSupported,
}: TurnEndNotificationDecisionInput): TurnEndNotificationDecision {
  if (!prefs.turnEndNotifyEnabled) return skip('disabled');
  if (runStartedAt === null) return skip('no-run');
  if (suppressNextCompletionNotify) return skip('aborted');

  const activeChatAlreadyVisible = appFocused && isActiveChat;
  if (prefs.turnEndNotifyOnlyWhenUnfocused && activeChatAlreadyVisible) {
    return skip('already-visible');
  }

  if (
    lastNotificationAt !== null &&
    now - lastNotificationAt >= 0 &&
    now - lastNotificationAt < TURN_END_NOTIFICATION_DEBOUNCE_MS
  ) {
    return skip('debounced');
  }

  const sound = prefs.turnEndNotifySound;
  const toast = prefs.turnEndNotifyToast && toastSupported;
  const attention = prefs.turnEndNotifyAttention;
  if (!sound && !toast && !attention) return skip('no-channel');

  return { shouldNotify: true, sound, toast, attention };
}
