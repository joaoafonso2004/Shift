import { useCallback, useMemo, useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import type { CatalogExercise } from '../../domain/catalog.ts';
import { DEFAULT_SETTINGS, restTargetFor } from '../../domain/settings.ts';
import { useCoop } from '../../state/coop.ts';
import type { HapticGate } from '../../motion/haptics.ts';
import { usePressScale } from '../../motion/usePressScale.ts';
import { useSortableList } from '../../motion/useSortable.ts';
import { useWorkout, type WorkoutExercise } from '../../state/workout.ts';
import { SetRow, SET_ROW_HEIGHT } from './SetRow.tsx';
import { SwapRing } from './SwapRing.tsx';

const CONFIDENCE_LABEL = {
  none: 'first time',
  low: 'low confidence',
  medium: 'learning',
  high: 'confident',
} as const;

function SmallButton({ label, onPress, gate }: { label: string; onPress: () => void; gate: HapticGate }) {
  const { gesture, style } = usePressScale({ onPress, gate });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#1e2129',
            backgroundColor: '#12141a',
          },
          style,
        ]}
      >
        <Text className="text-chalk-dim text-xs font-semibold">{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

export function ExerciseCard({ exercise, gate }: { exercise: WorkoutExercise; gate: HapticGate }) {
  const completeSet = useWorkout((s) => s.completeSet);
  const updateSet = useWorkout((s) => s.updateSet);
  const addSet = useWorkout((s) => s.addSet);
  const reorderSets = useWorkout((s) => s.reorderSets);
  const replaceExercise = useWorkout((s) => s.replaceExercise);
  const allExercises = useWorkout((s) => s.exercises);

  // Measured once. The ring needs a real width to translate cards by, and
  // reading it from layout beats hardcoding a screen assumption.
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width),
    [],
  );

  const inWorkout = useMemo(
    () => new Set(allExercises.filter((e) => e.id !== exercise.id).map((e) => e.exerciseId)),
    [allExercises, exercise.id],
  );
  const patternsToday = useMemo(
    () => new Set(allExercises.filter((e) => e.id !== exercise.id).map((e) => e.catalog.pattern)),
    [allExercises, exercise.id],
  );

  const handleSwap = useCallback(
    (next: CatalogExercise) => replaceExercise(exercise.id, next),
    [exercise.id, replaceExercise],
  );

  const setIds = useMemo(() => exercise.sets.map((s) => s.id), [exercise.sets]);

  const handleReorder = useCallback(
    (ordered: string[]) => reorderSets(exercise.id, ordered),
    [exercise.id, reorderSets],
  );

  const list = useSortableList({
    ids: setIds,
    rowHeight: SET_ROW_HEIGHT,
    onReorder: handleReorder,
    gate,
  });

  const coopStatus = useCoop((s) => s.status);
  const isMyTurn = useCoop((s) => s.isMyTurn());
  const finishTurn = useCoop((s) => s.finishTurn);

  const onComplete = useCallback(
    (setId: string) => {
      completeSet(exercise.id, setId);
      // In a squad, finishing a set *is* finishing your turn: your rest starts
      // and the bar passes on. Solo, none of this exists.
      if (coopStatus === 'live' && isMyTurn) {
        void finishTurn(restTargetFor(DEFAULT_SETTINGS, exercise.catalog.isCompound));
      }
    },
    [completeSet, coopStatus, exercise.catalog.isCompound, exercise.id, finishTurn, isMyTurn],
  );
  const onChange = useCallback(
    (setId: string, patch: { weightKg?: number; reps?: number }) =>
      updateSet(exercise.id, setId, patch),
    [updateSet, exercise.id],
  );

  const done = exercise.sets.filter((s) => s.completed).length;
  const prediction = exercise.prediction;

  return (
    <Animated.View
      className="rounded-3xl border border-ink-line bg-ink-soft p-4 gap-3"
      layout={LinearTransition.springify()}
      entering={FadeIn.duration(220)}
      exiting={FadeOut.duration(160)}
    >
      <View onLayout={onLayout}>
        {width > 0 ? (
          <SwapRing
            current={exercise.catalog}
            width={width}
            gate={gate}
            onSwap={handleSwap}
            inWorkout={inWorkout}
            patternsToday={patternsToday}
          />
        ) : (
          <View style={{ height: 132 }} />
        )}
      </View>

      <View className="flex-row items-center justify-between">
        <Text className="text-chalk-faint text-[10px]">
          {exercise.swappedFrom ? `swapped from ${exercise.swappedFrom.name}` : 'swipe to swap'}
        </Text>
        <View className="flex-row items-center gap-2">
          {coopStatus === 'live' ? (
            <View
              className="rounded-full px-2 py-1"
              style={{ backgroundColor: isMyTurn ? 'rgba(61,220,151,0.16)' : '#1e2129' }}
            >
              <Text
                style={{ color: isMyTurn ? '#3ddc97' : '#5b6270', fontSize: 9, fontWeight: '700' }}
              >
                {isMyTurn ? 'YOUR TURN' : 'WAITING'}
              </Text>
            </View>
          ) : null}
          <Text className="text-chalk-faint text-xs">
            {done}/{exercise.sets.length}
          </Text>
        </View>
      </View>

      {/* The predictor's reasoning, shown rather than hidden. A prefilled number
          the user does not understand is a number they will re-check every time. */}
      {prediction ? (
        <View className="rounded-xl bg-ink px-3 py-2">
          <Text className="text-chalk-dim text-[11px] leading-4">{prediction.rationale}</Text>
          <Text className="text-chalk-faint text-[9px] mt-1 uppercase tracking-wider">
            {CONFIDENCE_LABEL[prediction.confidence]}
            {prediction.relativeIntensity !== null
              ? ` · ${Math.round(prediction.relativeIntensity * 100)}% of best`
              : ''}
          </Text>
        </View>
      ) : null}

      {/* Absolutely positioned rows: the sortable list owns placement, so the
          container needs an explicit height. */}
      <View style={{ height: exercise.sets.length * SET_ROW_HEIGHT }}>
        {exercise.sets.map((set, index) => (
          <SetRow
            key={set.id}
            set={set}
            index={index}
            lattice={exercise.lattice}
            list={list}
            gate={gate}
            onComplete={onComplete}
            onChange={onChange}
          />
        ))}
      </View>

      <View className="flex-row gap-2">
        <SmallButton label="+ set" onPress={() => addSet(exercise.id)} gate={gate} />
      </View>

      <Text className="text-chalk-faint text-[9px]">{exercise.catalog.attribution}</Text>
    </Animated.View>
  );
}
