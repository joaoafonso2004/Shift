import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { toFtsQuery } from '../src/domain/catalog.ts';
import { DEFAULT_BAR, latticeFor } from '../src/domain/plates.ts';
import {
  buildProgressionState,
  plannedLoadFrom,
  predictNextSession,
} from '../src/domain/progression.ts';
import { initLocalDb, type SqlDb } from '../src/data/localSchema.ts';
import {
  addWorkoutExercise,
  historyFor,
  logSet,
  startWorkout,
} from '../src/data/repository.ts';
import { STARTER_ROUTINE } from '../src/data/starterRoutine.ts';

// ---------------------------------------------------------------------------
// Search input handling
// ---------------------------------------------------------------------------

test('search input becomes a prefix query so results appear while typing', () => {
  assert.equal(toFtsQuery('bench'), 'bench*');
  assert.equal(toFtsQuery('barbell bench press'), 'barbell* bench* press*');
});

test('characters that are FTS5 syntax cannot reach the query', () => {
  // Every one of these appears in real exercise names or real typing.
  assert.equal(toFtsQuery("farmer's walk"), 'farmer* s* walk*');
  assert.equal(toFtsQuery('pull-up'), 'pull* up*');
  assert.equal(toFtsQuery('press (v. 2)'), 'press* v* 2*');
  assert.equal(toFtsQuery('"quoted" AND ^weird:'), 'quoted* and* weird*');
});

test('an empty or punctuation-only search returns null rather than matching everything', () => {
  assert.equal(toFtsQuery(''), null);
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('!!!'), null);
});

// ---------------------------------------------------------------------------
// Equipment lattices
// ---------------------------------------------------------------------------

test('a barbell steps through loadable plate combinations', () => {
  const lattice = latticeFor('barbell');
  assert.equal(lattice.isPlateLoaded, true);
  assert.equal(lattice.minKg, DEFAULT_BAR.barWeightKg, 'starts at the bare bar');
  assert.ok(lattice.totals.includes(100));
  assert.ok(lattice.totals.includes(62.5), 'fractional plate loads are reachable');
});

test('non-plate equipment steps on a fixed grid and reports no plate work', () => {
  const dumbbell = latticeFor('dumbbell');
  assert.equal(dumbbell.isPlateLoaded, false);
  assert.deepEqual(dumbbell.platesFor(20), []);
  assert.equal(dumbbell.snap(21), 20, 'snaps to the rack increment');

  const machine = latticeFor('machine');
  assert.equal(machine.snap(63), 65);
});

test('every scrub stop is a load the equipment can actually express', () => {
  for (const loadType of ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'band']) {
    const lattice = latticeFor(loadType);
    assert.ok(lattice.totals.length > 0, `${loadType} has no steps`);
    for (const total of lattice.totals) {
      assert.equal(lattice.snap(total), total, `${loadType}: ${total}kg does not round-trip`);
    }
  }
});

test('unknown equipment falls back rather than throwing', () => {
  const lattice = latticeFor('jetpack');
  assert.ok(lattice.totals.length > 0);
});

// ---------------------------------------------------------------------------
// The starter routine drives the predictor
// ---------------------------------------------------------------------------

const NOW = '2026-08-01T10:00:00Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

function memoryDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  const adapter: SqlDb = {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    get: <T,>(sql: string, params: readonly unknown[] = []) =>
      (db.prepare(sql).get(...(params as never[])) as T) ?? null,
  };
  initLocalDb(adapter);
  return adapter;
}

/** Log real sessions through the real write path, then read them back. */
function withHistory(exerciseId: string, sessions: readonly { at: string; weight: number; reps: number }[]): SqlDb {
  const db = memoryDb();
  startWorkout(db, { id: 'w1', routineId: null, startedAt: daysAgo(30) });
  sessions.forEach((session, i) => {
    const wx = `wx${i}`;
    addWorkoutExercise(db, {
      id: wx, workoutId: 'w1', exerciseId,
      swappedFromExerciseId: null, orderIndex: i, at: session.at,
    });
    for (let s = 0; s < 3; s++) {
      logSet(db, {
        id: `${wx}-s${s}`, workoutExerciseId: wx, exerciseId, setIndex: s,
        weightKg: session.weight, reps: session.reps, rpe: null,
        isWarmup: false, completedAt: session.at,
      });
    }
  });
  return db;
}

function predictFrom(db: SqlDb, exerciseId: string, loadType: string) {
  const state = buildProgressionState(exerciseId, historyFor(db, exerciseId));
  return predictNextSession({ state, now: NOW, lattice: latticeFor(loadType) });
}

test('a rising log read back from the database produces a weight increase', () => {
  const db = withHistory('0043', [
    { at: daysAgo(21), weight: 92.5, reps: 10 },
    { at: daysAgo(14), weight: 95, reps: 11 },
    { at: daysAgo(7), weight: 95, reps: 12 },
  ]);
  const prediction = predictFrom(db, '0043', 'barbell');
  assert.equal(prediction.source, 'progression');
  assert.ok(plannedLoadFrom(prediction) > 95);
});

test('a mid-range log holds the weight and asks for another rep', () => {
  const db = withHistory('0025', [
    { at: daysAgo(20), weight: 70, reps: 8 },
    { at: daysAgo(13), weight: 70, reps: 9 },
    { at: daysAgo(6), weight: 70, reps: 10 },
  ]);
  const prediction = predictFrom(db, '0025', 'barbell');
  assert.equal(prediction.source, 'repeat');
  assert.equal(plannedLoadFrom(prediction), 70);
});

test('two short sessions in the log trigger a deload', () => {
  const db = withHistory('2330', [
    { at: daysAgo(19), weight: 65, reps: 10 },
    { at: daysAgo(12), weight: 65, reps: 6 },
    { at: daysAgo(5), weight: 65, reps: 5 },
  ]);
  const prediction = predictFrom(db, '2330', 'cable');
  assert.equal(prediction.source, 'deload');
  assert.ok(plannedLoadFrom(prediction) < 65);
});

test('a first run cold-starts every exercise and says so', () => {
  // No seed data anywhere: an empty database is the real first-launch state.
  const db = memoryDb();
  assert.equal(STARTER_ROUTINE.length, 4);

  for (const [id, loadType] of [
    ['0043', 'barbell'],
    ['0025', 'barbell'],
    ['2330', 'cable'],
    ['0405', 'dumbbell'],
  ] as const) {
    const prediction = predictFrom(db, id, loadType);
    assert.equal(prediction.source, 'default', `${id} should cold-start`);
    assert.equal(prediction.confidence, 'none');
    assert.match(prediction.rationale, /First time/);
    assert.ok(prediction.sets.length > 0, `${id} still has to arrive prefilled`);
    assert.ok(plannedLoadFrom(prediction) > 0);
  }
});

test('every prefilled weight is loadable, whatever the history says', () => {
  const cases = [
    ['0043', 'barbell', 92.5],
    ['0025', 'barbell', 70],
    ['2330', 'cable', 65],
    ['0405', 'dumbbell', 22],
  ] as const;

  for (const [id, loadType, weight] of cases) {
    const db = withHistory(id, [
      { at: daysAgo(14), weight, reps: 11 },
      { at: daysAgo(7), weight, reps: 12 },
    ]);
    const lattice = latticeFor(loadType);
    for (const s of predictFrom(db, id, loadType).sets) {
      assert.ok(
        lattice.totals.includes(s.weightKg),
        `${id}: ${s.weightKg}kg cannot be loaded on ${loadType}`,
      );
    }
  }
});
