import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET_COUNT,
  bucketFor,
  countHitches,
  emptyHistogram,
  inferRefreshHz,
  MIN_SAMPLES,
  STALL_MS,
  summarize,
  type FrameStatsInput,
} from '../src/motion/frameStats.ts';

/** Build an input as if `frames` frames had arrived at the given intervals. */
function record(deltas: readonly number[]): FrameStatsInput {
  const histogram = emptyHistogram();
  let sumMs = 0;
  let worstMs = 0;
  let stalls = 0;
  for (const dt of deltas) {
    histogram[bucketFor(dt)]! += 1;
    sumMs += dt;
    if (dt > worstMs) worstMs = dt;
    if (dt >= STALL_MS) stalls += 1;
  }
  return { frames: deltas.length, sumMs, worstMs, histogram, stalls };
}

function repeat(deltaMs: number, count: number): number[] {
  return Array.from({ length: count }, () => deltaMs);
}

test('display intervals land inside buckets, not on the boundaries', () => {
  // The whole point of the edge placement: 120/90/60/30Hz must be separable.
  assert.equal(bucketFor(8.33), 1, '120Hz');
  assert.equal(bucketFor(11.11), 2, '90Hz');
  assert.equal(bucketFor(16.67), 3, '60Hz');
  assert.equal(bucketFor(33.33), 5, '30Hz');
  assert.notEqual(bucketFor(8.33), bucketFor(16.67), '120Hz and 60Hz must never share a bucket');
});

test('bucketFor is total', () => {
  for (const dt of [0.1, 5.9, 6, 9.4, 13, 19.9, 27, 44, 79, 80, 5000]) {
    const b = bucketFor(dt);
    assert.ok(b >= 0 && b < BUCKET_COUNT, `${dt}ms produced bucket ${b}`);
  }
});

test('a ProMotion device is recognised as 120Hz', () => {
  assert.equal(inferRefreshHz(record(repeat(8.33, 500)).histogram), 120);
});

test('a 60Hz-capped display is recognised as 60Hz, not as dropped frames', () => {
  assert.equal(inferRefreshHz(record(repeat(16.67, 500)).histogram), 60);
});

test('refresh rate comes from the mode, so a few bad frames do not change it', () => {
  const deltas = [...repeat(8.33, 480), ...repeat(40, 20)];
  assert.equal(inferRefreshHz(record(deltas).histogram), 120);
});

test('a clean 120Hz run passes', () => {
  const stats = summarize(record(repeat(8.33, 600)));

  assert.equal(stats.verdict, 'pass');
  assert.equal(stats.inferredHz, 120);
  assert.equal(stats.budgetMs, 8.33);
  assert.equal(stats.hitches, 0);
  assert.ok(stats.fps > 119 && stats.fps < 121, `fps was ${stats.fps}`);
  assert.match(stats.headline, /120Hz sustained/);
});

test('a capped display is diagnosed as configuration, not performance', () => {
  const stats = summarize(record(repeat(16.67, 600)));

  assert.equal(stats.verdict, 'capped');
  assert.equal(stats.inferredHz, 60);
  // The distinction that matters: this is the "you forgot the Info.plist key"
  // case, and the headline must say so rather than blaming the render work.
  assert.match(stats.headline, /CADisableMinimumFrameDurationOnPhone/);
  assert.equal(stats.hitches, 0, 'a steady 60Hz is not hitching — it is capped');
});

test('a 120Hz display that misses its budget is diagnosed as dropping', () => {
  // 5% of frames at 20ms against an 8.33ms budget.
  const deltas = [...repeat(8.33, 570), ...repeat(20, 30)];
  const stats = summarize(record(deltas));

  assert.equal(stats.inferredHz, 120);
  assert.equal(stats.verdict, 'dropping');
  assert.ok(stats.hitchRate > 0.01);
  assert.match(stats.headline, /blocking the UI thread/);
});

test('the two failure modes are never confused', () => {
  const capped = summarize(record(repeat(16.67, 600)));
  const dropping = summarize(record([...repeat(8.33, 500), ...repeat(25, 100)]));

  assert.equal(capped.verdict, 'capped');
  assert.equal(dropping.verdict, 'dropping');
  // Both look like "60fps" on a naive counter; they need opposite responses.
  assert.ok(Math.abs(capped.fps - 60) < 1);
  assert.notEqual(capped.verdict, dropping.verdict);
});

test('a rare hitch under the tolerance still passes', () => {
  const deltas = [...repeat(8.33, 599), 20];
  const stats = summarize(record(deltas));
  assert.equal(stats.verdict, 'pass');
  assert.ok(stats.hitchRate <= 0.01);
});

test('stalls are counted apart from hitches', () => {
  // A 400ms frame is backgrounding or a mount freeze, not jank worth reporting
  // as a dropped frame — counting it as one would make every cold start fail.
  const stats = summarize(record([...repeat(8.33, 600), 400]));
  assert.equal(stats.stalls, 1);
  assert.equal(stats.verdict, 'pass');
  assert.equal(stats.worstDeltaMs, 400);
});

test('no verdict is given before there are enough frames', () => {
  const stats = summarize(record(repeat(8.33, MIN_SAMPLES - 1)));
  assert.equal(stats.verdict, 'unknown');
  assert.match(stats.headline, /Collecting frames/);
});

test('an empty sample does not divide by zero', () => {
  const stats = summarize({
    frames: 0,
    sumMs: 0,
    worstMs: 0,
    histogram: emptyHistogram(),
    stalls: 0,
  });
  assert.equal(stats.fps, 0);
  assert.equal(stats.inferredHz, null);
  assert.equal(stats.budgetMs, null);
  assert.equal(stats.verdict, 'unknown');
});

test('hitch counting is conservative at the bucket edges', () => {
  // Budget 8.33ms, tolerance 1.5 => threshold 12.5ms. The 9.5-13 bucket
  // straddles it and must not be counted, so the sentinel under-reports rather
  // than crying wolf.
  const hist = emptyHistogram();
  hist[2] = 100; // 9.5-13ms
  assert.equal(countHitches(hist, 1000 / 120), 0);

  const worse = emptyHistogram();
  worse[3] = 100; // 13-20ms, entirely past the threshold
  assert.equal(countHitches(worse, 1000 / 120), 100);
});

test('a 60Hz budget tolerates frames that would hitch at 120Hz', () => {
  const hist = emptyHistogram();
  hist[3] = 100; // 13-20ms
  assert.equal(countHitches(hist, 1000 / 120), 100, 'hitches against an 8.33ms budget');
  assert.equal(countHitches(hist, 1000 / 60), 0, 'fine against a 16.67ms budget');
});
