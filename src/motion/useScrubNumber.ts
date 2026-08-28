import { useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import type { GestureType } from 'react-native-gesture-handler';
import {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  Extrapolation,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { haptic, type HapticGate } from './haptics.ts';
import { springs } from './springs.ts';

export interface ScrubNumberOptions {
  /** Sorted ascending list of every value the control may land on. */
  steps: readonly number[];
  /** Currently committed value. Snapped to the nearest step on mount. */
  value: number;
  /** Called once, on gesture end. Never per frame. */
  onCommit: (value: number) => void;
  gate?: HapticGate;
  enabled?: boolean;
}

export interface ScrubNumber {
  gesture: GestureType;
  /** Live value during the drag. Feed this to a LiveNumber, not to React state. */
  display: SharedValue<number>;
  /** Lift and tint while scrubbing. */
  style: ReturnType<typeof useAnimatedStyle>;
  active: SharedValue<number>;
}

/** Nearest index into a sorted array. Ties resolve downward. */
function nearestIndex(steps: readonly number[], value: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  if (steps.length === 0) return 0;
  if (value <= steps[lo]!) return lo;
  if (value >= steps[hi]!) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]! <= value) lo = mid;
    else hi = mid;
  }
  return value - steps[lo]! <= steps[hi]! - value ? lo : hi;
}

/**
 * Hold-and-drag to change a number, with no keyboard involved.
 *
 * Scrubbing moves an **index into the achievable values**, not the value
 * itself. That is what makes it impossible to land on a weight the bar cannot
 * express — the lattice from the plate solver is the step list, so every stop is
 * loadable by construction and no rounding pass is needed afterwards.
 *
 * Travel per step shrinks as the drag speeds up, so a slow deliberate drag gives
 * fine control and a fast flick covers range. Each crossed detent fires a tick,
 * rate-limited by the shared haptic gate, so the finger feels the steps.
 *
 * Nothing crosses to the JS thread until the gesture ends.
 */
export function useScrubNumber(options: ScrubNumberOptions): ScrubNumber {
  const { steps, value, onCommit, gate, enabled = true } = options;

  const index = useSharedValue(nearestIndex(steps, value));
  const active = useSharedValue(0);
  const residual = useSharedValue(0);

  // Mirrored into the UI runtime **only when it actually changes**.
  //
  // Assigning on every render clones the whole array across runtimes each time.
  // A barbell lattice holds several hundred loads, and there are two of these
  // per set row, so an unconditional write is hundreds of cross-runtime copies
  // per render — exactly the capture-discipline failure that eats a frame
  // budget. The identity check is enough: `lattice.totals` is built once and
  // handed down unchanged.
  const stepValues = useSharedValue<number[]>([...steps]);
  const lastSteps = useRef(steps);
  if (lastSteps.current !== steps) {
    lastSteps.current = steps;
    stepValues.value = [...steps];
  }

  const display = useDerivedValue(() => {
    const list = stepValues.value;
    const i = Math.min(Math.max(Math.round(index.value), 0), list.length - 1);
    return list[i] ?? 0;
  });

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-6, 6])
        .onBegin(() => {
          'worklet';
          active.value = withSpring(1, springs.press);
          residual.value = 0;
          if (gate) haptic(gate, 'tick', Date.now());
        })
        .onChange((event) => {
          'worklet';
          const list = stepValues.value;
          if (list.length === 0) return;

          // Faster drag, less travel per step. Clamped so a violent flick cannot
          // skip the whole range in one frame.
          const pxPerStep = interpolate(
            Math.abs(event.velocityX),
            [0, 400, 2000],
            [26, 13, 6],
            Extrapolation.CLAMP,
          );

          residual.value += event.changeX;
          while (Math.abs(residual.value) >= pxPerStep) {
            const direction = residual.value > 0 ? 1 : -1;
            const next = index.value + direction;
            residual.value -= direction * pxPerStep;
            if (next < 0 || next > list.length - 1) {
              residual.value = 0;
              break;
            }
            index.value = next;
            if (gate) haptic(gate, 'tick', Date.now());
          }
        })
        .onFinalize(() => {
          'worklet';
          active.value = withSpring(0, springs.release);
          residual.value = 0;
          const list = stepValues.value;
          const i = Math.min(Math.max(Math.round(index.value), 0), list.length - 1);
          const committed = list[i];
          // One crossing to the JS thread per gesture, carrying a primitive.
          if (committed !== undefined) runOnJS(onCommit)(committed);
        }),
    [active, enabled, gate, index, onCommit, residual, stepValues],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + active.value * 0.08 }, { translateY: active.value * -2 }],
  }));

  return { gesture, display, style, active };
}
