import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { initLocalDb, type SqlDb } from '../src/data/localSchema.ts';
import {
  addWorkoutExercise,
  enqueue,
  exercisesWithHistory,
  finishWorkout,
  historyFor,
  logSet,
  markFailed,
  markSynced,
  pending,
  pruneOutbox,
  removeSet,
  startWorkout,
} from '../src/data/repository.ts';
import { buildProgressionState } from '../src/domain/progression.ts';

/**
 * The production queries, run against the real SQLite engine.
 *
 * `node:sqlite` and `expo-sqlite` differ in API but not in engine, so adapting
 * one to the `SqlDb` interface exercises exactly the SQL that ships.
 */
function memoryDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    get: <T,>(sql: string, params: readonly unknown[] = []) =>
      (db.prepare(sql).get(...(params as never[])) as T) ?? null,
  };
}

function fresh(): SqlDb {
  const db = memoryDb();
  initLocalDb(db);
  return db;
}

const T0 = '2026-08-01T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function seedWorkout(db: SqlDb, exerciseId = '0025'): string {
  startWorkout(db, { id: 'w1', routineId: null, startedAt: T0 });
  addWorkoutExercise(db, {
    id: 'wx1',
    workoutId: 'w1',
    exerciseId,
    swappedFromExerciseId: null,
    orderIndex: 0,
    at: T0,
  });
  return 'wx1';
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('the local schema applies cleanly and is idempotent', () => {
  const db = fresh();
  initLocalDb(db); // running migrations twice must not throw
  const tables = db.all<{ name: string }>(
    "select name from sqlite_master where type='table' order by name",
  );
  assert.deepEqual(
    tables.map((t) => t.name).filter((n) => !n.startsWith('sqlite_')),
    [
      'outbox',
      'saved_routine_exercises',
      'saved_routines',
      'sets',
      'workout_exercises',
      'workouts',
    ],
  );
});

test('deleting a workout cascades to its exercises and sets', () => {
  const db = fresh();
  seedWorkout(db);
  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
  });

  db.run('delete from workouts where id = ?', ['w1']);
  assert.equal(db.all('select * from sets').length, 0);
  assert.equal(db.all('select * from workout_exercises').length, 0);
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test('a logged set queues exactly one mutation', () => {
  const db = fresh();
  seedWorkout(db);
  const before = pending(db).length;

  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
  });

  assert.equal(pending(db).length, before + 1);
});

test('repeated edits to one set coalesce into a single pending row', () => {
  const db = fresh();
  seedWorkout(db);

  for (const weight of [80, 82.5, 85, 87.5]) {
    logSet(db, {
      id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
      weightKg: weight, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
    });
  }

  const setRows = pending(db).filter((r) => r.entity === 'set');
  assert.equal(setRows.length, 1, 'four edits must not queue four rows');
  assert.equal(JSON.parse(setRows[0]!.payload).weightKg, 87.5, 'the last value wins');
});

test('coalescing preserves ordering — a parent never falls behind its child', () => {
  const db = fresh();
  seedWorkout(db);
  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
  });
  // Editing the set again must not push it ahead of the workout that owns it.
  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 85, reps: 10, rpe: null, isWarmup: false, completedAt: at(1),
  });

  const order = pending(db).map((r) => r.entity);
  assert.deepEqual(order, ['workout', 'workout_exercise', 'set']);
});

test('an upsert and a delete for the same entity stay separate', () => {
  const db = fresh();
  seedWorkout(db);
  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
  });
  removeSet(db, 's1', at(1));

  const rows = pending(db).filter((r) => r.entity === 'set');
  assert.deepEqual(rows.map((r) => r.op).sort(), ['delete', 'upsert']);
});

test('synced rows leave the queue; failures stay with a reason', () => {
  const db = fresh();
  seedWorkout(db);
  const rows = pending(db);

  markSynced(db, [rows[0]!.seq], at(1));
  assert.equal(pending(db).length, rows.length - 1);

  const remaining = pending(db)[0]!;
  markFailed(db, remaining.seq, 'network unreachable');
  const after = pending(db).find((r) => r.seq === remaining.seq)!;
  assert.equal(after.attempts, 1);
  assert.match(after.last_error!, /network unreachable/);
  assert.equal(after.synced_at, null, 'a failed row must stay pending');
});

test('a synced entity can be queued again', () => {
  const db = fresh();
  enqueue(db, 'set', 's1', 'upsert', { weightKg: 80 }, T0);
  markSynced(db, [pending(db)[0]!.seq], at(1));

  enqueue(db, 'set', 's1', 'upsert', { weightKg: 85 }, at(2));
  const rows = pending(db);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]!.payload).weightKg, 85);
});

test('pruning removes synced history and leaves pending work alone', () => {
  const db = fresh();
  enqueue(db, 'set', 's1', 'upsert', {}, T0);
  enqueue(db, 'set', 's2', 'upsert', {}, T0);
  markSynced(db, [pending(db)[0]!.seq], at(1));

  const removed = pruneOutbox(db, at(60));
  assert.equal(removed, 1);
  assert.equal(pending(db).length, 1);
});

// ---------------------------------------------------------------------------
// History — what the predictor reads
// ---------------------------------------------------------------------------

test('history groups by session, not by calendar day', () => {
  const db = fresh();
  startWorkout(db, { id: 'w1', routineId: null, startedAt: T0 });

  // Two separate sessions on the same date.
  for (const [wx, minute] of [['wx1', 0], ['wx2', 300]] as const) {
    addWorkoutExercise(db, {
      id: wx, workoutId: 'w1', exerciseId: '0025',
      swappedFromExerciseId: null, orderIndex: 0, at: at(minute),
    });
    for (let i = 0; i < 3; i++) {
      logSet(db, {
        id: `${wx}-s${i}`, workoutExerciseId: wx, exerciseId: '0025', setIndex: i,
        weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: at(minute + i),
      });
    }
  }

  const history = historyFor(db, '0025');
  assert.equal(history.length, 2);
  assert.equal(history[0]!.sets.length, 3);
});

test('warmups never reach the predictor', () => {
  const db = fresh();
  seedWorkout(db);
  logSet(db, {
    id: 'warm', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 40, reps: 12, rpe: null, isWarmup: true, completedAt: T0,
  });
  logSet(db, {
    id: 'work', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 1,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: at(2),
  });

  const history = historyFor(db, '0025');
  assert.equal(history[0]!.sets.length, 1);
  assert.equal(history[0]!.sets[0]!.weightKg, 80);
});

test('history is ordered oldest first, so the trend fit sees time correctly', () => {
  const db = fresh();
  startWorkout(db, { id: 'w1', routineId: null, startedAt: T0 });
  const weights = [70, 75, 80];

  weights.forEach((weight, i) => {
    const wx = `wx${i}`;
    addWorkoutExercise(db, {
      id: wx, workoutId: 'w1', exerciseId: '0025',
      swappedFromExerciseId: null, orderIndex: i, at: at(i * 1000),
    });
    logSet(db, {
      id: `${wx}-s0`, workoutExerciseId: wx, exerciseId: '0025', setIndex: 0,
      weightKg: weight, reps: 10, rpe: null, isWarmup: false, completedAt: at(i * 1000),
    });
  });

  const history = historyFor(db, '0025');
  assert.deepEqual(history.map((s) => s.sets[0]!.weightKg), weights);

  const state = buildProgressionState('0025', history);
  assert.equal(state.sessionCount, 3);
  assert.ok(state.trendKgPerSession! > 0, 'a rising log must not read as a decline');
});

test('the local database feeds the predictor with no seed data at all', () => {
  // This is what replaces seedHistory.ts: real logged sets in, a prediction out.
  const db = fresh();
  startWorkout(db, { id: 'w1', routineId: null, startedAt: T0 });

  [10, 11, 12].forEach((reps, i) => {
    const wx = `wx${i}`;
    addWorkoutExercise(db, {
      id: wx, workoutId: 'w1', exerciseId: '0043',
      swappedFromExerciseId: null, orderIndex: i, at: at(i * 1000),
    });
    for (let s = 0; s < 3; s++) {
      logSet(db, {
        id: `${wx}-s${s}`, workoutExerciseId: wx, exerciseId: '0043', setIndex: s,
        weightKg: 95, reps, rpe: null, isWarmup: false, completedAt: at(i * 1000 + s),
      });
    }
  });

  const state = buildProgressionState('0043', historyFor(db, '0043'));
  assert.equal(state.sessionCount, 3);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastSets.length, 3);
  assert.equal(state.lastSets[0]!.reps, 12, 'the newest session must be the one carried forward');
});

test('exercisesWithHistory reports what the swap re-rank can boost', () => {
  const db = fresh();
  seedWorkout(db, '0025');
  logSet(db, {
    id: 's1', workoutExerciseId: 'wx1', exerciseId: '0025', setIndex: 0,
    weightKg: 80, reps: 10, rpe: null, isWarmup: false, completedAt: T0,
  });

  const known = exercisesWithHistory(db);
  assert.ok(known.has('0025'));
  assert.equal(known.has('0043'), false);
});

test('finishing a workout queues the completion', () => {
  const db = fresh();
  seedWorkout(db);
  finishWorkout(db, 'w1', at(45));

  const row = db.get<{ status: string; ended_at: string }>('select * from workouts where id = ?', ['w1']);
  assert.equal(row!.status, 'completed');
  assert.equal(row!.ended_at, at(45));
  assert.ok(pending(db).some((r) => r.entity === 'workout'));
});
