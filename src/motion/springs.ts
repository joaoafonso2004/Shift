import { ReduceMotion, type WithSpringConfig } from 'react-native-reanimated';

/**
 * Shift's motion vocabulary. Every animation in the app pulls its physics from
 * here — no inline spring configs anywhere. That is the only way a hundred
 * screens end up feeling like one product.
 *
 * All configs use `duration` + `dampingRatio` rather than `stiffness`/`mass`.
 * The perceptual-duration form is **refresh-rate independent**: the same config
 * settles in the same wall-clock time at 60Hz and 120Hz. Stiffness-based springs
 * do not, so a motion tuned on a ProMotion device would feel different on an
 * older one.
 *
 * `ReduceMotion.System` makes every spring honour the OS accessibility setting
 * without a single conditional at the call site.
 */

const base = { reduceMotion: ReduceMotion.System };

export const springs = {
  /** Finger-down compression. Fast and tight — this must feel instant. */
  press: { ...base, duration: 180, dampingRatio: 0.9 },

  /** Release rebound. Looser, with a hint of overshoot; this is the "alive" one. */
  release: { ...base, duration: 420, dampingRatio: 0.55 },

  /** Rows making room during a drag-reorder. Settles without wobbling. */
  reorder: { ...base, duration: 380, dampingRatio: 0.8 },

  /** Swipe-to-Swap card commit. Long enough to read as a morph, not a cut. */
  swap: { ...base, duration: 520, dampingRatio: 0.75 },

  /** Sheets and rails. Confident, no bounce. */
  sheet: { ...base, duration: 480, dampingRatio: 0.85 },

  /** PR celebration. The one place overshoot is the point. */
  celebrate: { ...base, duration: 700, dampingRatio: 0.45 },
} satisfies Record<string, WithSpringConfig>;

export type SpringName = keyof typeof springs;

/**
 * Apply the user's Reduce Motion preference to every spring at once.
 *
 * Mutating the shared configs rather than threading a parameter through every
 * call site is deliberate: Reanimated reads the config when the spring starts,
 * so one write here reaches all of them, and invariant #5 holds — call sites
 * still name a spring from this file and nothing else.
 *
 * `ReduceMotion.System` already honours the OS setting. This is the in-app
 * override for someone who wants calmer motion without turning it off
 * system-wide; the OS still wins when it asks for less.
 */
export function setReduceMotion(enabled: boolean): void {
  base.reduceMotion = enabled ? ReduceMotion.Always : ReduceMotion.System;
  for (const config of Object.values(springs)) {
    config.reduceMotion = base.reduceMotion;
  }
}

/**
 * Scale a view compresses to on press.
 *
 * Small on purpose: at 120Hz the eye reads the *rate* of change more than the
 * distance, so a subtle compression with a fast spring feels more responsive
 * than a large one with a slow spring.
 */
export const PRESS_SCALE = 0.96;
