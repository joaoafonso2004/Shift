import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { initLocalDb, type SqlDb } from '../src/data/localSchema.ts';
import {
  deleteRoutine,
  getRoutine,
  listRoutines,
  markRoutineRun,
  pending,
  saveRoutine,
  type SaveRoutineInput,
} from '../src/data/repository.ts';

/** Same harness as repository.test.ts: production SQL, real engine, no device. */
function fresh(): SqlDb {
  const db = new DatabaseSync(':memory:');
  const adapted: SqlDb = {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    get: <T,>(sql: string, params: readonly unknown[] = []) =>
      (db.prepare(sql).get(...(params as never[])) as T) ?? null,
  };
  initLocalDb(adapted);
  return adapted;
}

function routine(overrides: Partial<SaveRoutineInput> = {}): SaveRoutineInput {
  return {
    id: 'r1',
    title: 'Leg day',
    note: null,
    source: 'mine',
    fromHandle: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    exercises: [
      { exerciseId: '0043', sets: 3, reps: 5, restS: 240 },
      { exerciseId: '0025', sets: 3, reps: 8, restS: null },
    ],
    ...overrides,
  };
}

test('a saved routine reads back in the order it was written', () => {
  const db = fresh();
  saveRoutine(db, routine());

  const stored = getRoutine(db, 'r1');
  assert.equal(stored?.title, 'Leg day');
  assert.deepEqual(
    stored?.exercises.map((e) => e.exerciseId),
    ['0043', '0025'],
  );
});

test('a prescribed rest is kept and an absent one stays null', () => {
  // Null is not "no rest" — it means the receiver's own compound/isolation
  // settings decide, which is the right default for a routine someone else wrote.
  const db = fresh();
  saveRoutine(db, routine());

  const stored = getRoutine(db, 'r1')!;
  assert.equal(stored.exercises[0]!.restS, 240);
  assert.equal(stored.exercises[1]!.restS, null);
});

test('saving over a routine replaces its exercises rather than appending them', () => {
  const db = fresh();
  saveRoutine(db, routine());
  saveRoutine(db, routine({ title: 'Leg day v2', exercises: [{ exerciseId: '2330', sets: 4, reps: 12, restS: null }] }));

  const stored = getRoutine(db, 'r1')!;
  assert.equal(stored.title, 'Leg day v2');
  assert.deepEqual(stored.exercises.map((e) => e.exerciseId), ['2330']);
});

test('a reordered routine saves without colliding with its own rows', () => {
  // order_index is half the primary key, so an in-place update would hit the
  // row that has not moved yet. Delete-then-insert is why this passes.
  const db = fresh();
  saveRoutine(db, routine());
  saveRoutine(db, routine({
    exercises: [
      { exerciseId: '0025', sets: 3, reps: 8, restS: null },
      { exerciseId: '0043', sets: 3, reps: 5, restS: 240 },
    ],
  }));

  assert.deepEqual(
    getRoutine(db, 'r1')!.exercises.map((e) => e.exerciseId),
    ['0025', '0043'],
  );
});

test('an unknown routine reads back as nothing rather than throwing', () => {
  assert.equal(getRoutine(fresh(), 'nope'), null);
});

test('the list is ordered by what was last trained, not what was last saved', () => {
  const db = fresh();
  saveRoutine(db, routine({ id: 'old', title: 'Old', createdAt: '2026-01-01T00:00:00.000Z' }));
  saveRoutine(db, routine({ id: 'new', title: 'New', createdAt: '2026-08-01T00:00:00.000Z' }));

  assert.deepEqual(listRoutines(db).map((r) => r.id), ['new', 'old']);

  markRoutineRun(db, 'old', '2026-08-28T18:00:00.000Z');
  assert.deepEqual(listRoutines(db).map((r) => r.id), ['old', 'new']);
});

test('the list counts exercises without loading them', () => {
  const db = fresh();
  saveRoutine(db, routine());
  saveRoutine(db, routine({ id: 'r2', title: 'Empty', exercises: [] }));

  const byId = new Map(listRoutines(db).map((r) => [r.id, r]));
  assert.equal(byId.get('r1')!.exerciseCount, 2);
  assert.equal(byId.get('r2')!.exerciseCount, 0);
});

test('a routine from a friend keeps its attribution', () => {
  const db = fresh();
  saveRoutine(db, routine({ source: 'friend', fromHandle: 'ana', note: 'devagar na descida' }));

  const stored = getRoutine(db, 'r1')!;
  assert.equal(stored.source, 'friend');
  assert.equal(stored.fromHandle, 'ana');
  assert.equal(stored.note, 'devagar na descida');
});

test('deleting a routine takes its exercises with it', () => {
  const db = fresh();
  saveRoutine(db, routine());
  deleteRoutine(db, 'r1');

  assert.equal(getRoutine(db, 'r1'), null);
  assert.equal(db.all('select * from saved_routine_exercises').length, 0);
});

test('routines never enter the outbox', () => {
  // They are a preference, not history. Queueing them would buy a sync path and
  // a conflict policy for data that costs nothing to recreate.
  const db = fresh();
  saveRoutine(db, routine());
  markRoutineRun(db, 'r1', '2026-08-28T18:00:00.000Z');

  assert.deepEqual(pending(db), []);
});
