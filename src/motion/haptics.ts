import * as Haptics from 'expo-haptics';
import { runOnJS } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

/**
 * Haptic feedback, Phase 1.
 *
 * `expo-haptics` is a JS-thread API, so calling it from a worklet costs a
 * `runOnJS` hop — the call queues behind whatever the JS thread is doing,
 * typically 1–3 frames. For most presses that is invisible. For the co-op
 * "tactile synchronisation" pillar it is not: a haptic landing 25ms after the
 * visual reads as broken.
 *
 * Phase 2 replaces `dispatch` with a synchronous JSI binding installed on the UI
 * runtime (a local Expo module or Nitro module), so haptic and visual originate
 * in the same frame. Everything else in this file — the rate limiter, the
 * priority ordering, the self-relevance filter — stays exactly as it is. That is
 * why the call sites go through `haptic()` rather than touching expo-haptics.
 */

export type HapticKind = 'tick' | 'press' | 'commit' | 'warn' | 'celebrate';

/** Highest wins when two land inside the same limiter window. */
const PRIORITY: Record<HapticKind, number> = {
  tick: 0,
  press: 1,
  warn: 2,
  commit: 3,
  celebrate: 4,
};

/**
 * Minimum gap between haptics.
 *
 * Not a nicety: with a squad of four, every member's events multiply, and a
 * phone that buzzes continuously trains the user to switch haptics off — which
 * would remove a core pillar of the product. Rate limiting here is what keeps
 * total haptic load O(1) in squad size rather than O(N).
 */
export const MIN_HAPTIC_GAP_MS = 400;

function dispatch(kind: HapticKind): void {
  switch (kind) {
    case 'tick':
      void Haptics.selectionAsync();
      return;
    case 'press':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    case 'commit':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    case 'warn':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    case 'celebrate':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
  }
}

export interface HapticGate {
  /** Timestamp of the last fired haptic, in the animation clock's units. */
  lastAt: SharedValue<number>;
  /** Priority of the last fired haptic. */
  lastPriority: SharedValue<number>;
  /** 0 off … 3 intense, mirroring profiles.haptic_intensity. */
  intensity: SharedValue<number>;
}

/**
 * Fire a haptic from inside a worklet.
 *
 * Lower-priority events inside the limiter window are **dropped rather than
 * queued** — a late haptic is worse than no haptic, because it desynchronises
 * from the motion that caused it.
 */
export function haptic(gate: HapticGate, kind: HapticKind, nowMs: number): boolean {
  'worklet';
  if (gate.intensity.value <= 0) return false;

  const priority = PRIORITY[kind];
  const elapsed = nowMs - gate.lastAt.value;
  if (elapsed < MIN_HAPTIC_GAP_MS && priority <= gate.lastPriority.value) return false;

  gate.lastAt.value = nowMs;
  gate.lastPriority.value = priority;
  runOnJS(dispatch)(kind);
  return true;
}
