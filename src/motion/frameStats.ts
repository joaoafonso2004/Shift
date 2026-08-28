/**
 * Frame-interval analysis for Shift's frame sentinel.
 *
 * Deliberately pure and dependency-free so it can be unit-tested in Node. The
 * hook that feeds it (`useFrameSentinel`) cannot be tested off-device, but the
 * arithmetic that decides pass/fail can, and that is the part that would
 * silently lie if it were wrong.
 *
 * Everything here is worklet-safe: no closures over module state, no allocation
 * in the hot path, and `bucketFor` carries the directive so it can be called
 * from inside `useFrameCallback`.
 */

/**
 * Bucket upper edges in milliseconds.
 *
 * Chosen so the common display intervals land clearly *inside* a bucket rather
 * than on a boundary: 120Hz = 8.33ms, 90Hz = 11.11ms, 60Hz = 16.67ms,
 * 30Hz = 33.33ms. A histogram costs O(1) memory and no per-frame allocation,
 * which matters because this runs on every single frame it is measuring.
 */
export const BUCKET_EDGES_MS: readonly number[] = [6, 9.5, 13, 20, 28, 45, 80, Infinity];
export const BUCKET_COUNT = 8;

/** Nominal refresh rate each bucket corresponds to; null where it maps to nothing real. */
export const BUCKET_HZ: readonly (number | null)[] = [null, 120, 90, 60, 40, 30, null, null];

/** Frames slower than this are a stall (backgrounding, a JS freeze), not a hitch. */
export const STALL_MS = 80;

/** A frame exceeding its budget by this factor is a hitch. */
export const HITCH_TOLERANCE = 1.5;

/** Above this share of hitched frames, motion is visibly rough. */
export const MAX_HITCH_RATE = 0.01;

/** Below this many frames, any verdict is noise. */
export const MIN_SAMPLES = 120;

export function bucketFor(deltaMs: number): number {
  'worklet';
  for (let i = 0; i < BUCKET_EDGES_MS.length; i++) {
    if (deltaMs < BUCKET_EDGES_MS[i]!) return i;
  }
  return BUCKET_COUNT - 1;
}

export type FrameVerdict =
  /** Not enough frames yet. */
  | 'unknown'
  /** Running at 120Hz and holding it. */
  | 'pass'
  /** Display is pinned near 60Hz — a configuration failure, not a perf one. */
  | 'capped'
  /** 120Hz display, but too many frames miss the budget — a perf failure. */
  | 'dropping';

export interface FrameStatsInput {
  frames: number;
  sumMs: number;
  worstMs: number;
  histogram: readonly number[];
  stalls: number;
}

export interface FrameStats {
  frames: number;
  fps: number;
  meanDeltaMs: number;
  worstDeltaMs: number;
  /** Display refresh inferred from the modal bucket, ignoring stalls. */
  inferredHz: number | null;
  budgetMs: number | null;
  hitches: number;
  hitchRate: number;
  stalls: number;
  histogram: readonly number[];
  verdict: FrameVerdict;
  /** One line stating what the numbers mean and, on failure, what to do. */
  headline: string;
}

/**
 * Infer the display refresh rate from the modal frame interval.
 *
 * This is the actual 120fps proof. If `CADisableMinimumFrameDurationOnPhone` is
 * missing from the iOS Info.plist, frames arrive ~16.7ms apart no matter how
 * cheap the work is, and this returns 60 — distinguishing "the display is
 * capped" from "we are dropping frames", which look identical in an FPS counter
 * but have completely different fixes.
 */
export function inferRefreshHz(histogram: readonly number[]): number | null {
  let bestBucket = -1;
  let bestCount = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    if (BUCKET_HZ[i] === null) continue;
    const count = histogram[i] ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestBucket = i;
    }
  }
  return bestBucket === -1 ? null : BUCKET_HZ[bestBucket]!;
}

/**
 * Count frames that missed their budget.
 *
 * Buckets are coarse, so a bucket counts as hitched only when its entire range
 * sits beyond the tolerance. That biases toward under-reporting, which is the
 * right direction: a sentinel that cries wolf gets ignored.
 */
export function countHitches(
  histogram: readonly number[],
  budgetMs: number,
): number {
  const threshold = budgetMs * HITCH_TOLERANCE;
  let hitches = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const lowerEdge = i === 0 ? 0 : BUCKET_EDGES_MS[i - 1]!;
    if (lowerEdge >= STALL_MS) continue; // stalls are counted separately
    if (lowerEdge >= threshold) hitches += histogram[i] ?? 0;
  }
  return hitches;
}

export function summarize(input: FrameStatsInput): FrameStats {
  const { frames, sumMs, worstMs, histogram, stalls } = input;

  const meanDeltaMs = frames > 0 ? sumMs / frames : 0;
  const fps = meanDeltaMs > 0 ? 1000 / meanDeltaMs : 0;
  const inferredHz = frames > 0 ? inferRefreshHz(histogram) : null;
  const budgetMs = inferredHz === null ? null : 1000 / inferredHz;
  const hitches = budgetMs === null ? 0 : countHitches(histogram, budgetMs);
  const hitchRate = frames > 0 ? hitches / frames : 0;

  let verdict: FrameVerdict = 'unknown';
  let headline = `Collecting frames… ${frames}/${MIN_SAMPLES}`;

  if (frames >= MIN_SAMPLES && inferredHz !== null) {
    if (inferredHz <= 60) {
      verdict = 'capped';
      headline =
        `Display is running at ${inferredHz}Hz. ProMotion is not unlocked — check ` +
        `CADisableMinimumFrameDurationOnPhone in app.json and rebuild (a JS reload will not apply it).`;
    } else if (hitchRate > MAX_HITCH_RATE) {
      verdict = 'dropping';
      headline =
        `${inferredHz}Hz display, but ${(hitchRate * 100).toFixed(1)}% of frames missed the ` +
        `${budgetMs!.toFixed(2)}ms budget. Something is blocking the UI thread.`;
    } else {
      verdict = 'pass';
      headline =
        `${inferredHz}Hz sustained — ${(hitchRate * 100).toFixed(2)}% hitched against a ` +
        `${budgetMs!.toFixed(2)}ms budget over ${frames} frames.`;
    }
  }

  return {
    frames,
    fps: Math.round(fps * 10) / 10,
    meanDeltaMs: Math.round(meanDeltaMs * 100) / 100,
    worstDeltaMs: Math.round(worstMs * 100) / 100,
    inferredHz,
    budgetMs: budgetMs === null ? null : Math.round(budgetMs * 100) / 100,
    hitches,
    hitchRate: Math.round(hitchRate * 10000) / 10000,
    stalls,
    histogram,
    verdict,
    headline,
  };
}

export function emptyHistogram(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0];
}

/** Human labels for the histogram, for the harness readout. */
export const BUCKET_LABELS: readonly string[] = [
  '<6ms',
  '6–9.5 (120Hz)',
  '9.5–13 (90Hz)',
  '13–20 (60Hz)',
  '20–28',
  '28–45 (30Hz)',
  '45–80',
  '80ms+ (stall)',
];
