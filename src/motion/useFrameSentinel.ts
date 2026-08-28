import { useCallback, useEffect, useState } from 'react';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import {
  BUCKET_COUNT,
  bucketFor,
  emptyHistogram,
  STALL_MS,
  summarize,
  type FrameStats,
} from './frameStats.ts';

export interface FrameSentinel {
  /** Snapshot, refreshed at `sampleHz`. Cheap: a low-frequency JS render, never per frame. */
  stats: FrameStats;
  reset: () => void;
  running: boolean;
  setRunning: (running: boolean) => void;
  /** Live counters for driving an AnimatedTextInput with zero React renders. */
  live: {
    frames: SharedValue<number>;
    sumMs: SharedValue<number>;
    worstMs: SharedValue<number>;
  };
}

export interface FrameSentinelOptions {
  /** How often to snapshot to JS state for display. Deliberately not per frame. */
  sampleHz?: number;
  autoStart?: boolean;
}

/**
 * Measures the real frame interval on the UI thread.
 *
 * Every accumulator is a shared value written from inside `useFrameCallback`, so
 * measuring costs no bridge traffic and no React renders — an instrument that
 * perturbs what it measures is worse than none. The only JS work is a snapshot a
 * couple of times a second for the readout.
 *
 * React DevTools' profiler is close to useless for this app: it measures the
 * thread we have deliberately vacated. This is the replacement, and it is
 * intended to stay on in development permanently, not just during this proof.
 */
export function useFrameSentinel(options: FrameSentinelOptions = {}): FrameSentinel {
  const sampleHz = options.sampleHz ?? 2;
  const [running, setRunning] = useState(options.autoStart ?? true);
  const [stats, setStats] = useState<FrameStats>(() =>
    summarize({ frames: 0, sumMs: 0, worstMs: 0, histogram: emptyHistogram(), stalls: 0 }),
  );

  const frames = useSharedValue(0);
  const sumMs = useSharedValue(0);
  const worstMs = useSharedValue(0);
  const stalls = useSharedValue(0);
  const histogram = useSharedValue<number[]>(emptyHistogram());

  const frameCallback = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame;
    if (dt === null || dt <= 0) return;

    frames.value += 1;
    sumMs.value += dt;
    if (dt > worstMs.value) worstMs.value = dt;
    if (dt >= STALL_MS) stalls.value += 1;

    const bucket = bucketFor(dt);
    // .modify() mutates in place on the UI runtime. `histogram.value = [...]`
    // would reallocate and re-clone the array across runtimes every frame.
    histogram.modify((h) => {
      'worklet';
      h[bucket] = (h[bucket] ?? 0) + 1;
      return h;
    }, false);
  }, false);

  useEffect(() => {
    frameCallback.setActive(running);
  }, [running, frameCallback]);

  const reset = useCallback(() => {
    frames.value = 0;
    sumMs.value = 0;
    worstMs.value = 0;
    stalls.value = 0;
    histogram.value = emptyHistogram();
  }, [frames, sumMs, worstMs, stalls, histogram]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const h = histogram.value;
      setStats(
        summarize({
          frames: frames.value,
          sumMs: sumMs.value,
          worstMs: worstMs.value,
          histogram: h.slice(0, BUCKET_COUNT),
          stalls: stalls.value,
        }),
      );
    }, 1000 / sampleHz);
    return () => clearInterval(id);
  }, [running, sampleHz, frames, sumMs, worstMs, stalls, histogram]);

  return { stats, reset, running, setRunning, live: { frames, sumMs, worstMs } };
}
