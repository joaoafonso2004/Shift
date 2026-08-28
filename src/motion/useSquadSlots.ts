import { useEffect, useMemo } from 'react';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

/** Fixed slot count. The schema constrains `color_slot` to 0..3 to match. */
export const SQUAD_SLOTS = 4;

/** Member state encoded as a number so worklets can compare without strings. */
export const STATE_CODE = {
  idle: 0,
  working: 1,
  resting: 2,
  ready: 3,
  stalled: 4,
  away: 5,
} as const;

export interface SquadSlots {
  /** Set progress 0..1, indexed by colorSlot. */
  progress: SharedValue<number>[];
  /** STATE_CODE value, indexed by colorSlot. */
  state: SharedValue<number>[];
  /** Rest end as epoch ms; 0 means no timer running. */
  restEndsAt: SharedValue<number>[];
  restTargetS: SharedValue<number>[];
  /** Whether the slot is occupied at all. */
  occupied: SharedValue<number>[];
  /** colorSlot of the active lifter, or -1. */
  activeSlot: SharedValue<number>;
  /** colorSlot the screen is emphasising, or -1. */
  focusSlot: SharedValue<number>;
  memberCount: SharedValue<number>;
  /** Server time minus device time, from the join-time RPC sampling. */
  clockOffsetMs: SharedValue<number>;
  /** Server-aligned now, ticked once per frame on the UI thread. */
  nowMs: SharedValue<number>;
}

/**
 * Four preallocated shared-value slots for the squad.
 *
 * **Shared values cannot be created as members join.** Hooks are fixed-count, so
 * a dynamically sized squad cannot mean a dynamically sized set of shared
 * values. Four slots are allocated once at mount and indexed by `color_slot` —
 * which is precisely why the database constrains that column to 0..3. The
 * constraint exists to serve this render architecture, not the other way round.
 *
 * A member joining therefore changes a *value*, not the component tree.
 *
 * One frame callback maintains `nowMs` for every countdown on screen. Each pod
 * derives its own remaining time from timestamps it already holds, so the cost
 * of the timers is flat in squad size: one writer, N readers, no polling and no
 * further packets (§2.5).
 */
export function useSquadSlots(active = false): SquadSlots {
  // Allocated individually rather than in a loop: hook order must be static.
  const p0 = useSharedValue(0);
  const p1 = useSharedValue(0);
  const p2 = useSharedValue(0);
  const p3 = useSharedValue(0);

  const s0 = useSharedValue<number>(STATE_CODE.idle);
  const s1 = useSharedValue<number>(STATE_CODE.idle);
  const s2 = useSharedValue<number>(STATE_CODE.idle);
  const s3 = useSharedValue<number>(STATE_CODE.idle);

  const r0 = useSharedValue(0);
  const r1 = useSharedValue(0);
  const r2 = useSharedValue(0);
  const r3 = useSharedValue(0);

  const t0 = useSharedValue(90);
  const t1 = useSharedValue(90);
  const t2 = useSharedValue(90);
  const t3 = useSharedValue(90);

  const o0 = useSharedValue(0);
  const o1 = useSharedValue(0);
  const o2 = useSharedValue(0);
  const o3 = useSharedValue(0);

  const activeSlot = useSharedValue(-1);
  const focusSlot = useSharedValue(-1);
  const memberCount = useSharedValue(0);
  const clockOffsetMs = useSharedValue(0);
  const nowMs = useSharedValue(Date.now());

  const clock = useFrameCallback(() => {
    'worklet';
    nowMs.value = Date.now() + clockOffsetMs.value;
  }, false);

  // Only runs while a squad is present. A frame callback ticking forever during
  // every solo workout is a wasted wake-up on every single frame, for a value
  // nothing is reading.
  useEffect(() => {
    clock.setActive(active);
    return () => clock.setActive(false);
  }, [clock, active]);

  return useMemo(
    () => ({
      progress: [p0, p1, p2, p3],
      state: [s0, s1, s2, s3],
      restEndsAt: [r0, r1, r2, r3],
      restTargetS: [t0, t1, t2, t3],
      occupied: [o0, o1, o2, o3],
      activeSlot,
      focusSlot,
      memberCount,
      clockOffsetMs,
      nowMs,
    }),
    [
      p0, p1, p2, p3, s0, s1, s2, s3, r0, r1, r2, r3, t0, t1, t2, t3,
      o0, o1, o2, o3, activeSlot, focusSlot, memberCount, clockOffsetMs, nowMs,
    ],
  );
}

/**
 * Push a squad snapshot into the shared values, from the JS thread.
 *
 * This is the whole ingress path: a Realtime message lands, this writes numbers,
 * and the rail animates. React never renders for a progress change — the only
 * squad event allowed to touch the tree is a join or leave, which moves
 * `memberCount` (§4.7).
 */
export function writeSlots(
  slots: SquadSlots,
  members: readonly {
    colorSlot: 0 | 1 | 2 | 3;
    state: keyof typeof STATE_CODE;
    currentSetIndex: number;
    targetSets: number;
    restEndsAt: string | null;
    restTargetS: number;
  }[],
  activeSlot: number,
  focusSlot: number,
): void {
  for (let i = 0; i < SQUAD_SLOTS; i++) {
    slots.occupied[i]!.value = 0;
  }

  for (const m of members) {
    const i = m.colorSlot;
    slots.occupied[i]!.value = 1;
    slots.state[i]!.value = STATE_CODE[m.state];
    slots.progress[i]!.value =
      m.targetSets > 0 ? Math.min(1, m.currentSetIndex / m.targetSets) : 0;
    slots.restEndsAt[i]!.value = m.restEndsAt === null ? 0 : Date.parse(m.restEndsAt);
    slots.restTargetS[i]!.value = m.restTargetS;
  }

  slots.memberCount.value = members.length;
  slots.activeSlot.value = activeSlot;
  slots.focusSlot.value = focusSlot;
}
