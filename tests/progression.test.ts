import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBarbellLattice } from '../src/domain/plates.ts';
import type { BarConfig, PlateInventory } from '../src/domain/plates.ts';
import {
  buildProgressionState,
  DEFAULT_SCHEME,
  detrainingFactor,
  epleyE1rm,
  inferSetShape,
  plannedLoadFrom,
  predictNextSession,
  relativeIntensity,
  theilSenSlope,
  weightForReps,
} from '../src/domain/progression.ts';
import type { ProgressionState, SessionRecord, SetRecord } from '../src/domain/progression.ts';

const BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
const GYM: PlateInventory = { '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2 };
const LATTICE = buildBarbellLattice(BAR, GYM);

const NOW = '2026-08-01T10:00:00Z';

function day(offsetDays: number): string {
  return new Date(Date.parse(NOW) - offsetDays * 86_400_000).toISOString();
}

function set(setIndex: number, weightKg: number, reps: number, at: string): SetRecord {
  return { setIndex, weightKg, reps, rpe: null, isWarmup: false, completedAt: at };
}

function session(at: string, ...pairs: [number, number][]): SessionRecord {
  return { at, sets: pairs.map(([w, r], i) => set(i, w, r, at)) };
}

// ---------------------------------------------------------------------------

test('Epley matches the sets.e1rm generated column and its rep window', () => {
  assert.equal(epleyE1rm(100, 1), 103.33);
  assert.equal(epleyE1rm(100, 10), 133.33);
  assert.equal(epleyE1rm(100, 12), 140);
  assert.equal(epleyE1rm(100, 13), null, 'beyond 12 reps the database stores null too');
  assert.equal(epleyE1rm(100, 0), null);
  assert.equal(epleyE1rm(null, 5), null);
  assert.equal(epleyE1rm(0, 5), null);
});

test('weightForReps inverts Epley', () => {
  const e = epleyE1rm(100, 10)!;
  assert.equal(weightForReps(e, 10), 100);
});

test('Theil-Sen ignores a deload that would drag a regression line', () => {
  const clean = [100, 102, 104, 106, 108];
  const withDeload = [100, 102, 104, 70, 108];

  assert.equal(theilSenSlope(clean), 2);
  assert.equal(
    theilSenSlope(withDeload),
    2,
    'one bad session must not change the prescribed progression',
  );
  assert.equal(theilSenSlope([100]), null, 'a single session has no trend');
});

test('progression state is derived from raw history', () => {
  const state = buildProgressionState('0001', [
    session(day(21), [80, 10], [80, 9], [80, 8]),
    session(day(14), [80, 12], [80, 11], [80, 10]),
    session(day(7), [82.5, 9], [82.5, 8], [82.5, 8]),
  ]);

  assert.equal(state.sessionCount, 3);
  assert.equal(state.lastSessionAt, day(7));
  assert.equal(state.lastSets.length, 3);
  assert.equal(state.bestE1rm, epleyE1rm(80, 12));
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(state.trendKgPerSession! > 0);
});

test('warmups never contribute to state or prediction', () => {
  const at = day(7);
  const state = buildProgressionState('0001', [
    {
      at,
      sets: [
        { setIndex: 0, weightKg: 40, reps: 12, rpe: null, isWarmup: true, completedAt: at },
        set(1, 100, 10, at),
      ],
    },
  ]);
  assert.equal(state.lastSets.length, 1);
  assert.equal(state.bestE1rm, epleyE1rm(100, 10));
});

test('an empty history produces an empty state rather than throwing', () => {
  const state = buildProgressionState('0001', []);
  assert.equal(state.sessionCount, 0);
  assert.equal(state.bestE1rm, null);
  assert.equal(state.trendKgPerSession, null);
});

// ---------------------------------------------------------------------------

test('hitting the top of the rep range adds weight and resets reps', () => {
  const state = buildProgressionState('0001', [
    session(day(14), [80, 10], [80, 10], [80, 10]),
    session(day(7), [80, 12], [80, 12], [80, 12]),
  ]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  assert.equal(p.source, 'progression');
  assert.equal(plannedLoadFrom(p), 82.5);
  assert.equal(p.sets[0]!.reps, DEFAULT_SCHEME.repRange[0]);
  assert.equal(p.sets.length, 3);
  assert.match(p.rationale, /adding 2.5kg/);
});

test('falling short of the top of the range keeps the weight and asks for one more rep', () => {
  const state = buildProgressionState('0001', [
    session(day(14), [80, 8], [80, 8], [80, 8]),
    session(day(7), [80, 9], [80, 9], [80, 9]),
  ]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  assert.equal(p.source, 'repeat');
  assert.equal(plannedLoadFrom(p), 80);
  assert.equal(p.sets[0]!.reps, 10);
  assert.match(p.rationale, /one more rep/);
});

test('one short session repeats; two in a row deloads', () => {
  const failing = session(day(7), [100, 6], [100, 5], [100, 5]);

  const once = buildProgressionState('0001', [
    session(day(21), [100, 10], [100, 10], [100, 10]),
    failing,
  ]);
  assert.equal(once.consecutiveFailures, 1);
  assert.equal(predictNextSession({ state: once, now: NOW, lattice: LATTICE }).source, 'repeat');

  const twice = buildProgressionState('0001', [
    session(day(21), [100, 10], [100, 10], [100, 10]),
    session(day(14), [100, 6], [100, 6], [100, 5]),
    failing,
  ]);
  assert.equal(twice.consecutiveFailures, 2);

  const p = predictNextSession({ state: twice, now: NOW, lattice: LATTICE });
  assert.equal(p.source, 'deload');
  assert.ok(plannedLoadFrom(p) < 100, `expected a backoff, got ${plannedLoadFrom(p)}kg`);
  assert.match(p.rationale, /backing off/);
});

test('a flat trend blocks a weight increase even after a good session', () => {
  // Best-set e1RM drifting down: the last session hit reps, but strength is not moving.
  const state: ProgressionState = {
    exerciseId: '0001',
    lastSessionAt: day(7),
    lastSets: [set(0, 100, 12, day(7)), set(1, 100, 12, day(7)), set(2, 100, 12, day(7))],
    bestE1rm: 150,
    bestE1rmAt: day(60),
    sessionCount: 8,
    trendKgPerSession: -0.8,
    consecutiveFailures: 0,
  };
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  assert.equal(plannedLoadFrom(p), 100, 'should hold weight rather than push into a stall');
  assert.match(p.rationale, /trend is flat/);
});

test('a layoff scales the prediction down and says so', () => {
  const state = buildProgressionState('0001', [
    session(day(70), [100, 12], [100, 12], [100, 12]),
  ]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  assert.ok(plannedLoadFrom(p) < 100, `expected decay, got ${plannedLoadFrom(p)}kg`);
  assert.equal(p.confidence, 'low');
  assert.match(p.rationale, /weeks off/);
});

test('detraining has a grace period and a floor', () => {
  assert.equal(detrainingFactor(day(3), NOW), 1, 'a normal gap must not decay');
  assert.equal(detrainingFactor(day(14), NOW), 1, 'the grace period is inclusive');
  assert.ok(detrainingFactor(day(60), NOW) < 1);
  assert.ok(detrainingFactor(day(3650), NOW) >= 0.7, 'decay must not fall through the floor');
  assert.equal(detrainingFactor(null, NOW), 1);
});

test('a never-performed exercise starts light and admits it', () => {
  const state = buildProgressionState('0001', []);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  assert.equal(p.source, 'default');
  assert.equal(p.confidence, 'none');
  assert.equal(plannedLoadFrom(p), LATTICE.minKg, 'falls back to the bare bar');
  assert.equal(p.relativeIntensity, null);
  assert.match(p.rationale, /Shift learns your working weight/);
});

test('a swap onto a new exercise transfers from a related lift, conservatively', () => {
  const source = buildProgressionState('bench', [
    session(day(7), [100, 10], [100, 10], [100, 10]),
  ]);
  const p = predictNextSession({
    state: buildProgressionState('incline', []),
    now: NOW,
    lattice: LATTICE,
    transfer: { fromExerciseId: 'bench', state: source, ratio: 0.8, label: 'your bench press' },
  });

  assert.equal(p.source, 'transfer');
  assert.equal(p.confidence, 'low');
  assert.ok(
    plannedLoadFrom(p) < 80,
    `transfer must undershoot the raw ratio, got ${plannedLoadFrom(p)}kg`,
  );
  assert.match(p.rationale, /your bench press/);
});

test('transfer is ignored when the source has no history either', () => {
  const p = predictNextSession({
    state: buildProgressionState('incline', []),
    now: NOW,
    lattice: LATTICE,
    transfer: { fromExerciseId: 'bench', state: buildProgressionState('bench', []), ratio: 0.8 },
  });
  assert.equal(p.source, 'default');
});

// ---------------------------------------------------------------------------

test('set shape is learned, not assumed', () => {
  const at = day(7);
  const backoff = [set(0, 100, 5, at), set(1, 90, 8, at), set(2, 80, 10, at)];
  const shape = inferSetShape(backoff, 3);

  assert.equal(shape[0], 1);
  assert.ok(shape[1]! < 1 && shape[2]! < shape[1]!, 'descending sets must stay descending');
});

test('a top-set-and-backoff lifter is not handed three identical numbers', () => {
  const at = day(7);
  const state = buildProgressionState('0001', [
    { at, sets: [set(0, 100, 12, at), set(1, 90, 12, at), set(2, 80, 12, at)] },
  ]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });

  const weights = p.sets.map((s) => s.weightKg);
  assert.equal(new Set(weights).size, 3, `expected a descending shape, got ${weights}`);
  assert.ok(weights[0]! > weights[1]! && weights[1]! > weights[2]!);
  assert.equal(p.sets[0]!.isTopSet, true);
  assert.equal(p.sets[2]!.isTopSet, false);
});

test('shape is padded when history has fewer sets than the scheme asks for', () => {
  const at = day(7);
  const state = buildProgressionState('0001', [{ at, sets: [set(0, 100, 12, at)] }]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });
  assert.equal(p.sets.length, DEFAULT_SCHEME.targetSets);
});

test('every predicted weight is loadable on the bar', () => {
  const state = buildProgressionState('0001', [
    session(day(7), [83.7, 12], [83.7, 12], [83.7, 12]),
  ]);
  const p = predictNextSession({ state, now: NOW, lattice: LATTICE });
  for (const s of p.sets) {
    assert.ok(LATTICE.totals.includes(s.weightKg), `${s.weightKg}kg cannot be loaded`);
  }
});

test('predictions are pure — the same inputs always give the same answer', () => {
  const state = buildProgressionState('0001', [
    session(day(14), [80, 10], [80, 10], [80, 10]),
    session(day(7), [80, 12], [80, 12], [80, 12]),
  ]);
  const run = () => predictNextSession({ state, now: NOW, lattice: LATTICE });
  assert.deepEqual(run(), run());
});

test('confidence tracks how much Shift actually knows', () => {
  const mk = (sessions: SessionRecord[]) =>
    predictNextSession({
      state: buildProgressionState('0001', sessions),
      now: NOW,
      lattice: LATTICE,
    }).confidence;

  assert.equal(mk([]), 'none');
  assert.equal(mk([session(day(7), [80, 10])]), 'low', 'one session is not a pattern');
  assert.equal(mk([session(day(21), [80, 10]), session(day(7), [80, 11])]), 'medium');
  assert.equal(
    mk([
      session(day(28), [80, 9]),
      session(day(21), [80, 10]),
      session(day(14), [80, 11]),
      session(day(7), [80, 11]),
    ]),
    'high',
  );
});

test('relative intensity is the squad-rail metric, and absent without a best e1RM', () => {
  assert.equal(relativeIntensity(100, 125), 0.8);
  assert.equal(relativeIntensity(100, null), null);
  assert.equal(relativeIntensity(100, 0), null);
});
