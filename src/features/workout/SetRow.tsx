import { memo, useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, withSpring } from 'react-native-reanimated';

import { haptic, type HapticGate } from '../../motion/haptics.ts';
import { LiveNumber } from '../../motion/LiveNumber.tsx';
import { springs } from '../../motion/springs.ts';
import { useScrubNumber } from '../../motion/useScrubNumber.ts';
import { useSortableRow, type SortableList } from '../../motion/useSortable.ts';
import type { LoadLattice } from '../../domain/plates.ts';
import type { WorkoutSet } from '../../state/workout.ts';

export const SET_ROW_HEIGHT = 62;

/** Reps are just integers; the lattice concept only applies to load. */
const REP_STEPS = Array.from({ length: 30 }, (_, i) => i + 1);

interface ScrubFieldProps {
  steps: readonly number[];
  value: number;
  unit: string;
  onCommit: (value: number) => void;
  gate: HapticGate;
  decimals: number;
}

function ScrubField({ steps, value, unit, onCommit, gate, decimals }: ScrubFieldProps) {
  const scrub = useScrubNumber({ steps, value, onCommit, gate });

  const format = useCallback(
    (n: number) => {
      'worklet';
      return decimals > 0 ? n.toFixed(decimals).replace(/\.0+$/, '') : String(Math.round(n));
    },
    [decimals],
  );

  const tint = useAnimatedStyle(() => ({
    borderColor: scrub.active.value > 0.5 ? '#4f8cff' : '#1e2129',
    backgroundColor: scrub.active.value > 0.5 ? 'rgba(79,140,255,0.12)' : '#08090c',
  }));

  return (
    <GestureDetector gesture={scrub.gesture}>
      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'baseline',
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 10,
            paddingVertical: 6,
            minWidth: 78,
          },
          tint,
          scrub.style,
        ]}
      >
        <LiveNumber
          value={scrub.display}
          format={format}
          style={{ color: '#f4f5f7', fontSize: 20, fontWeight: '700', padding: 0, minWidth: 34 }}
        />
        <Text className="text-chalk-faint text-[10px] ml-1">{unit}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

export interface SetRowProps {
  set: WorkoutSet;
  index: number;
  lattice: LoadLattice;
  list: SortableList;
  gate: HapticGate;
  onComplete: (setId: string) => void;
  onChange: (setId: string, patch: { weightKg?: number; reps?: number }) => void;
}

/**
 * One logged set.
 *
 * Memoised, and every prop it receives is either stable or a primitive that
 * changes only on a real state transition. Scrubbing a number re-renders this
 * row exactly once — when the finger lifts — because the live value travels
 * through a shared value into `LiveNumber` rather than through React.
 */
function SetRowComponent({
  set,
  index,
  lattice,
  list,
  gate,
  onComplete,
  onChange,
}: SetRowProps) {
  const sortable = useSortableRow(list, set.id);

  const completeGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(10_000)
        .onEnd((_e, success) => {
          'worklet';
          if (!success) return;
          haptic(gate, 'commit', Date.now());
          // One crossing per interaction, on end, carrying a primitive.
          runOnJS(onComplete)(set.id);
        }),
    [gate, onComplete, set.id],
  );

  const checkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withSpring(set.completed ? 1 : 0.85, springs.release) }],
    opacity: withSpring(set.completed ? 1 : 0.35, springs.release),
  }));

  const onWeight = useCallback(
    (weightKg: number) => onChange(set.id, { weightKg }),
    [onChange, set.id],
  );
  const onReps = useCallback((reps: number) => onChange(set.id, { reps }), [onChange, set.id]);

  return (
    <Animated.View style={[{ height: SET_ROW_HEIGHT, paddingVertical: 4 }, sortable.style]}>
      <View
        className="flex-1 flex-row items-center gap-2 rounded-2xl border border-ink-line bg-ink-soft px-3"
        style={{ opacity: set.completed ? 0.55 : 1 }}
      >
        <GestureDetector gesture={sortable.gesture}>
          <View style={{ width: 26, paddingVertical: 12 }}>
            <Text className="text-chalk-faint text-[11px] font-bold">{index + 1}</Text>
            <Text className="text-chalk-faint text-[9px]">⠿</Text>
          </View>
        </GestureDetector>

        <ScrubField
          steps={lattice.totals}
          value={set.weightKg}
          unit="kg"
          decimals={2}
          onCommit={onWeight}
          gate={gate}
        />
        <ScrubField
          steps={REP_STEPS}
          value={set.reps}
          unit="reps"
          decimals={0}
          onCommit={onReps}
          gate={gate}
        />

        {set.fromPrediction ? (
          <View className="rounded-full bg-ink px-2 py-1">
            <Text className="text-chalk-faint text-[9px]">auto</Text>
          </View>
        ) : null}

        <View style={{ flex: 1 }} />

        <GestureDetector gesture={completeGesture}>
          <Animated.View
            style={[
              {
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: set.completed ? '#3ddc97' : '#1e2129',
              },
              checkStyle,
            ]}
          >
            <Text style={{ color: set.completed ? '#08090c' : '#5b6270', fontSize: 18, fontWeight: '900' }}>
              ✓
            </Text>
          </Animated.View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

export const SetRow = memo(SetRowComponent);
