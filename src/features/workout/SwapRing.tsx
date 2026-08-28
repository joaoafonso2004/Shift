import { memo, useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { getAlternatives } from '../../data/catalog.ts';
import { rerankAlternatives, type CatalogExercise } from '../../domain/catalog.ts';
import { ringWindow, slotKey } from '../../domain/swipe.ts';
import type { HapticGate } from '../../motion/haptics.ts';
import { useCardRing, useRingSlotStyle, type CardRing } from '../../motion/useCardRing.ts';

export const SWAP_CARD_HEIGHT = 132;

const MUSCLE_HUE: Record<string, string> = {
  pectorals: '#ff8a4f',
  lats: '#4f8cff',
  upper_back: '#4f8cff',
  delts: '#c77dff',
  rear_delts: '#c77dff',
  biceps: '#3ddc97',
  triceps: '#3ddc97',
  quads: '#ffb020',
  hamstrings: '#ffb020',
  glutes: '#ffb020',
  calves: '#ffb020',
  abs: '#ff5f56',
  obliques: '#ff5f56',
};

function hueFor(target: string): string {
  return MUSCLE_HUE[target] ?? '#5b6270';
}

interface SlotProps {
  ring: CardRing;
  candidateIndex: number;
  exercise: CatalogExercise;
  explanation: string | null;
  isOriginal: boolean;
}

function Slot({ ring, candidateIndex, exercise, explanation, isOriginal }: SlotProps) {
  const style = useRingSlotStyle(ring, candidateIndex);
  const hue = hueFor(exercise.target);

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          height: SWAP_CARD_HEIGHT,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: '#1e2129',
          backgroundColor: '#12141a',
          padding: 14,
          justifyContent: 'space-between',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {/* Media placeholder. The dataset's 1,324 GIFs are third-party licensed
          and not hosted yet (§5.5, §8), so the card carries a muscle-coded mark
          instead of an image it has no right to serve. */}
      <View
        style={{
          position: 'absolute',
          right: -28,
          top: -28,
          width: 120,
          height: 120,
          borderRadius: 60,
          backgroundColor: hue,
          opacity: 0.14,
        }}
      />

      <View>
        <Text className="text-chalk text-xl font-bold" numberOfLines={2}>
          {exercise.name}
        </Text>
        <Text className="text-chalk-faint text-[11px] mt-1">
          {exercise.target.replace(/_/g, ' ')} · {exercise.pattern.replace(/_/g, ' ')} ·{' '}
          {exercise.rawEquipment}
        </Text>
      </View>

      <View className="flex-row items-center gap-2">
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: isOriginal ? '#1e2129' : `${hue}22`,
          }}
        >
          <Text style={{ color: isOriginal ? '#5b6270' : hue, fontSize: 9, fontWeight: '700' }}>
            {isOriginal ? 'PLANNED' : 'ALTERNATIVE'}
          </Text>
        </View>
        {explanation ? (
          <Text className="text-chalk-faint text-[10px] flex-1" numberOfLines={1}>
            {explanation}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

export interface SwapRingProps {
  current: CatalogExercise;
  width: number;
  gate: HapticGate;
  onSwap: (next: CatalogExercise) => void;
  /** Exercises already in today's workout, so the ring never offers a duplicate. */
  inWorkout: ReadonlySet<string>;
  patternsToday: ReadonlySet<string>;
}

/**
 * Horizontal swipe between an exercise and its biomechanical alternatives.
 *
 * Candidates are queried **once, at mount** — an indexed local read against the
 * bundled catalog, so the whole ring is populated before any finger arrives.
 * Nothing is fetched, measured, or mounted while the gesture is running.
 */
function SwapRingComponent({
  current,
  width,
  gate,
  onSwap,
  inWorkout,
  patternsToday,
}: SwapRingProps) {
  // Keyed on the exercise id: swapping rebuilds the candidate list around the
  // new exercise, which is what makes the ring walkable rather than a fixed list.
  const candidates = useMemo(() => {
    const alternatives = rerankAlternatives(
      getAlternatives(current.id, 12).map((a) => ({
        exercise: a.exercise,
        score: a.score,
        reason: a.reason,
      })),
      {
        availableLoadTypes: [],
        hasHistory: new Set<string>(),
        inWorkout,
        patternsToday: patternsToday as ReadonlySet<never>,
        blocked: new Set<string>(),
      },
    );

    return [
      { exercise: current, explanation: null as string | null },
      ...alternatives.map((a) => ({ exercise: a.exercise, explanation: a.explanation })),
    ];
  }, [current, inWorkout, patternsToday]);

  const [index, setIndex] = useState(0);

  const handleIndexChange = useCallback(
    (next: number) => {
      setIndex(next);
      const target = candidates[next];
      if (target && target.exercise.id !== current.id) {
        onSwap(target.exercise);
        // The swap re-seeds `current`, so the ring restarts around the new
        // exercise with a fresh candidate list.
        setIndex(0);
      }
    },
    [candidates, current.id, onSwap],
  );

  const ring = useCardRing({
    count: candidates.length,
    index,
    onIndexChange: handleIndexChange,
    width,
    gate,
  });

  const window = ringWindow(index, candidates.length);

  return (
    <GestureDetector gesture={ring.gesture}>
      <View style={{ height: SWAP_CARD_HEIGHT }}>
        {window.map((candidateIndex) => {
          const entry = candidates[candidateIndex]!;
          return (
            <Slot
              key={slotKey(candidateIndex)}
              ring={ring}
              candidateIndex={candidateIndex}
              exercise={entry.exercise}
              explanation={entry.explanation}
              isOriginal={candidateIndex === 0}
            />
          );
        })}
      </View>
    </GestureDetector>
  );
}

export const SwapRing = memo(SwapRingComponent);
