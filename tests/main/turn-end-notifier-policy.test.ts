import { describe, expect, it } from 'vitest';

import {
  TURN_END_NOTIFICATION_DEBOUNCE_MS,
  decideTurnEndNotification,
  type TurnEndNotificationPrefs,
} from '../../src/main/turn-end-notifier-policy.js';

const ENABLED_PREFS: TurnEndNotificationPrefs = {
  turnEndNotifyEnabled: true,
  turnEndNotifySound: true,
  turnEndNotifyToast: true,
  turnEndNotifyAttention: true,
  turnEndNotifyOnlyWhenUnfocused: true,
};

function decide(overrides: Partial<Parameters<typeof decideTurnEndNotification>[0]> = {}) {
  return decideTurnEndNotification({
    prefs: ENABLED_PREFS,
    now: 10_000,
    appFocused: false,
    isActiveChat: true,
    runStartedAt: 9_000,
    suppressNextCompletionNotify: false,
    lastNotificationAt: null,
    toastSupported: true,
    ...overrides,
  });
}

describe('turn-end notification policy', () => {
  it('notifies through all enabled channels for a completed background run', () => {
    expect(decide()).toMatchObject({
      shouldNotify: true,
      sound: true,
      toast: true,
      attention: true,
    });
  });

  it('skips when notifications are disabled', () => {
    expect(
      decide({ prefs: { ...ENABLED_PREFS, turnEndNotifyEnabled: false } }),
    ).toMatchObject({ shouldNotify: false, reason: 'disabled' });
  });

  it('skips agent_end events that were not paired with agent_start', () => {
    expect(decide({ runStartedAt: null })).toMatchObject({
      shouldNotify: false,
      reason: 'no-run',
    });
  });

  it('skips abort-induced completions', () => {
    expect(decide({ suppressNextCompletionNotify: true })).toMatchObject({
      shouldNotify: false,
      reason: 'aborted',
    });
  });

  it('stays quiet when the active completed chat is already visible', () => {
    expect(decide({ appFocused: true, isActiveChat: true })).toMatchObject({
      shouldNotify: false,
      reason: 'already-visible',
    });
  });

  it('still notifies for an inactive chat that finishes while the app is focused', () => {
    expect(decide({ appFocused: true, isActiveChat: false })).toMatchObject({
      shouldNotify: true,
    });
  });

  it('debounces duplicate completions per runtime', () => {
    expect(decide({ lastNotificationAt: 10_000 - TURN_END_NOTIFICATION_DEBOUNCE_MS + 1 })).toMatchObject({
      shouldNotify: false,
      reason: 'debounced',
    });
  });

  it('falls back to sound and attention when native toasts are unsupported', () => {
    expect(decide({ toastSupported: false })).toMatchObject({
      shouldNotify: true,
      sound: true,
      toast: false,
      attention: true,
    });
  });
});
