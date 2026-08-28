import { useCallback, useEffect, useMemo } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import type { GestureType } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { haptic, type HapticGate } from './haptics.ts';
import { springs } from './springs.ts';

export interface SortableList {
  /** id -> current index. The single source of truth for row placement. */
  positions: SharedValue<Record<string, number>>;
  activeId: SharedValue<string | null>;
  rowHeight: number;
  gate: HapticGate | undefined;
  commit: () => void;
  count: number;
}

export interface SortableOptions {
  ids: readonly string[];
  rowHeight: number;
  onReorder: (ids: string[]) => void;
  gate?: HapticGate;
}

/**
 * Drag-to-reorder driven by manual springs.
 *
 * `LinearTransition` is the obvious tool here and it is the wrong one: layout
 * animations react to a layout that has already been committed, so the animation
 * is always chasing the finger and the row under the thumb disagrees with the
 * rows around it by half a frame. Instead every row is absolutely positioned
 * from a shared `positions` map, the dragged row tracks the finger 1:1, and
 * every displaced row runs its own spring.
 *
 * All of it happens on the UI thread. React learns the new order once, when the
 * finger lifts.
 *
 * `LinearTransition` remains correct for insert and remove, where there is no
 * finger to track.
 */
export function useSortableList(options: SortableOptions): SortableList {
  const { ids, rowHeight, onReorder, gate } = options;

  const positions = useSharedValue<Record<string, number>>(
    Object.fromEntries(ids.map((id, i) => [id, i])),
  );
  const activeId = useSharedValue<string | null>(null);

  // Re-seed when the set of ids changes (a set added or removed), but never
  // while a drag is in flight — that would yank the row out from under the
  // finger.
  //
  // In an effect, not a useMemo: React is free to discard and recompute a memo,
  // so using one to perform a write is unsound. Keyed on the joined ids rather
  // than the array, whose identity changes on every render.
  const key = ids.join('|');
  useEffect(() => {
    if (activeId.value !== null) return;
    positions.value = Object.fromEntries(key.split('|').map((id, i) => [id, i]));
  }, [key, positions, activeId]);

  const commit = useCallback(() => {
    const current = positions.value;
    const ordered = [...ids].sort((a, b) => (current[a] ?? 0) - (current[b] ?? 0));
    onReorder(ordered);
  }, [ids, onReorder, positions]);

  return { positions, activeId, rowHeight, gate, commit, count: ids.length };
}

export interface SortableRow {
  gesture: GestureType;
  style: ReturnType<typeof useAnimatedStyle>;
  isActive: SharedValue<number>;
}

/**
 * Per-row gesture and placement.
 *
 * Called from inside a row component so each row owns its own hooks — never in
 * a loop.
 */
export function useSortableRow(list: SortableList, id: string): SortableRow {
  const { positions, activeId, rowHeight, gate } = list;

  const translateY = useSharedValue((positions.value[id] ?? 0) * rowHeight);
  const isActive = useSharedValue(0);
  const offset = useSharedValue(0);

  // Follow the map whenever this row is not the one being dragged. A worklet
  // reacting to a worklet: React is not involved in reordering at all.
  useAnimatedReaction(
    () => positions.value[id] ?? 0,
    (index) => {
      if (activeId.value === id) return;
      translateY.value = withSpring(index * rowHeight, springs.reorder);
    },
    [id, rowHeight],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(180)
        .onStart(() => {
          'worklet';
          activeId.value = id;
          isActive.value = withSpring(1, springs.press);
          offset.value = translateY.value;
          if (gate) haptic(gate, 'commit', Date.now());
        })
        .onChange((event) => {
          'worklet';
          if (activeId.value !== id) return;
          translateY.value = offset.value + event.translationY;

          const map = positions.value;
          const from = map[id] ?? 0;
          const max = Object.keys(map).length - 1;
          const to = Math.min(Math.max(Math.round(translateY.value / rowHeight), 0), max);
          if (to === from) return;

          // Swap with whoever currently holds the target slot.
          const displaced = Object.keys(map).find((other) => map[other] === to);
          positions.modify((current) => {
            'worklet';
            if (displaced !== undefined) current[displaced] = from;
            current[id] = to;
            return current;
          });
          if (gate) haptic(gate, 'tick', Date.now());
        })
        .onFinalize(() => {
          'worklet';
          if (activeId.value !== id) return;
          const index = positions.value[id] ?? 0;
          translateY.value = withSpring(index * rowHeight, springs.reorder);
          isActive.value = withSpring(0, springs.release);
          activeId.value = null;
          runOnJS(list.commit)();
        }),
    [activeId, gate, id, isActive, list, offset, positions, rowHeight, translateY],
  );

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    transform: [{ translateY: translateY.value }, { scale: 1 + isActive.value * 0.03 }],
    zIndex: isActive.value > 0 ? 10 : 0,
    shadowOpacity: isActive.value * 0.35,
    shadowRadius: isActive.value * 16,
    shadowOffset: { width: 0, height: isActive.value * 8 },
    shadowColor: '#000',
  }));

  return { gesture, style, isActive };
}
