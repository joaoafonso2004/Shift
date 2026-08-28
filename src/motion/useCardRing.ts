import { useCallback, useMemo } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import type { GestureType } from 'react-native-gesture-handler';
import {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { resolveSwipe } from '../domain/swipe.ts';
import { haptic, type HapticGate } from './haptics.ts';
import { springs } from './springs.ts';

export interface CardRingOptions {
  count: number;
  index: number;
  onIndexChange: (index: number) => void;
  width: number;
  gate?: HapticGate;
  enabled?: boolean;
}

export interface CardRing {
  gesture: GestureType;
  /** Fractional card position. 2.4 means "40% of the way from card 2 to card 3". */
  position: SharedValue<number>;
  width: number;
}

/**
 * The Swipe-to-Swap card ring.
 *
 * Zero layout thrash is structural here, not an optimisation. Every card the
 * gesture can reach is already mounted and measured, the gesture only writes to
 * transform properties, and the ring advances by animating a single continuous
 * `position` value rather than by remounting anything.
 *
 * `position` deliberately carries both the drag and the settled state. Using a
 * separate drag offset that resets to zero on commit produces a one-frame flash
 * of the outgoing card centred, because the shared value resets immediately
 * while the React state that decides slot contents lands a frame or two later.
 */
export function useCardRing(options: CardRingOptions): CardRing {
  const { count, index, onIndexChange, width, gate, enabled = true } = options;

  const position = useSharedValue(index);
  const start = useSharedValue(index);

  // Follow external index changes (a swap committed elsewhere, a reset).
  // Assigning during render is safe for shared values and avoids an effect that
  // would land a frame late.
  if (!Number.isNaN(index)) {
    start.value = index;
  }

  const commit = useCallback(
    (next: number) => {
      if (next !== index) onIndexChange(next);
    },
    [index, onIndexChange],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled && count > 1)
        .activeOffsetX([-12, 12])
        .failOffsetY([-18, 18])
        .onBegin(() => {
          'worklet';
          start.value = position.value;
        })
        .onChange((event) => {
          'worklet';
          if (width <= 0) return;
          const next = start.value - event.changeX / width;
          // Rubber-band past the ends rather than stopping dead: the boundary
          // should feel elastic, not broken.
          if (next < 0) position.value = next * 0.35;
          else if (next > count - 1) position.value = count - 1 + (next - (count - 1)) * 0.35;
          else position.value = next;
        })
        .onFinalize((event) => {
          'worklet';
          const target = resolveSwipe({
            startIndex: Math.round(start.value),
            translationX: event.translationX,
            velocityX: event.velocityX,
            width,
            count,
          });

          if (target !== Math.round(start.value) && gate) haptic(gate, 'commit', Date.now());

          position.value = withSpring(target, {
            ...springs.swap,
            // Hand the spring the gesture's velocity so the card keeps moving
            // rather than restarting from rest.
            velocity: width > 0 ? -event.velocityX / width : 0,
          });
          runOnJS(commit)(target);
        }),
    [commit, count, enabled, gate, position, start, width],
  );

  return { gesture, position, width };
}

/**
 * Placement and morph for one slot in the ring.
 *
 * Called from inside the card component so each slot owns its hooks. Only
 * transform and opacity are animated — both are handled entirely on the
 * compositor, so nothing here can trigger a layout pass.
 */
export function useRingSlotStyle(ring: CardRing, candidateIndex: number) {
  return useAnimatedStyle(() => {
    const delta = candidateIndex - ring.position.value;
    const abs = Math.abs(delta);

    return {
      transform: [
        { perspective: 900 },
        { translateX: delta * ring.width },
        // The outgoing card turns away rather than merely sliding — the morph
        // the brief asks for, done with a property that costs nothing.
        { rotateY: `${interpolate(delta, [-1, 0, 1], [26, 0, -26], Extrapolation.CLAMP)}deg` },
        { scale: interpolate(abs, [0, 1], [1, 0.88], Extrapolation.CLAMP) },
      ],
      opacity: interpolate(abs, [0, 0.85, 1.4], [1, 0.65, 0], Extrapolation.CLAMP),
      zIndex: abs < 0.5 ? 2 : 1,
    };
  });
}
