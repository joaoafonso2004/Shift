import { useMemo } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import type { GestureType } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { PRESS_SCALE, springs } from './springs.ts';
import { haptic, type HapticGate } from './haptics.ts';

export interface PressScaleOptions {
  onPress?: () => void;
  gate?: HapticGate;
  scale?: number;
  enabled?: boolean;
}

/**
 * The base touch response every pressable in Shift uses.
 *
 * Compression starts on `onBegin`, not `onStart`. `onBegin` fires the instant a
 * finger lands; `onStart` waits for the gesture to be recognised as a tap, which
 * is after the ~130ms it takes to rule out a pan. Using `onStart` here is the
 * single most common reason a React Native app feels a beat behind the finger.
 *
 * Release always springs back on `onFinalize`, so a cancelled or interrupted
 * gesture cannot strand a view compressed.
 */
export function usePressScale(options: PressScaleOptions = {}): {
  gesture: GestureType;
  style: ReturnType<typeof useAnimatedStyle>;
} {
  const { onPress, gate, scale: pressScale = PRESS_SCALE, enabled = true } = options;
  const scale = useSharedValue(1);

  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .enabled(enabled)
        .maxDuration(10_000)
        .onBegin(() => {
          'worklet';
          scale.value = withSpring(pressScale, springs.press);
          // Reanimated 4 dropped `_getAnimationTimestamp`. `Date.now()` is
          // available on the UI runtime and millisecond resolution is ample for
          // a 400ms gate — this is a rate limiter, not a clock.
          if (gate) haptic(gate, 'press', Date.now());
        })
        .onEnd((_event, success) => {
          'worklet';
          if (success && onPress) runOnJS(onPress)();
        })
        .onFinalize(() => {
          'worklet';
          scale.value = withSpring(1, springs.release);
        }),
    [enabled, gate, onPress, pressScale, scale],
  );

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return { gesture, style };
}
