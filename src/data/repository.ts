import type { SessionRecord, SetRecord } from '../domain/progression.ts';
import type { SqlDb } from './localSchema.ts';

/**
 * Every read and write against the device-local database.
 *
 * Takes a `SqlDb` rather than importing a driver, so the same functions run
 * under `expo-sqlite` on device and `node:sqlite` in the tests. Nothing here
 * touches the network — the outbox is appended in the same transaction as the
 * fact it describes, and a separate flush drains it later.
 */

export type OutboxEntity = 'workout' | 'workout_exercise' | 'set';
export type OutboxOp = 'upsert' | 'delete';

export interface OutboxRow {
  seq: number;
  entity: OutboxEntity;
  entity_id: string;
  op: OutboxOp;
  payload: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
}

/**
 * Queue a mutation.
 *
 * Coalescing is deliberate: a partial unique index keeps at most one pending
 * upsert per entity, so editing the same set five times before the network
 * returns leaves one row carrying the final value rather than five rows
 * replaying an animation of the user's indecision. Ordering is preserved
 * because the existing row keeps its original `seq` — the parent workout stays
 * ahead of its sets no matter how often a set is edited.
 */
export function enqueue(
  db: SqlDb,
  entity: OutboxEntity,
  entityId: string,
  op: OutboxOp,
  payload: unknown,
  now: string,
): void {
  db.run(
    `insert into outbox (entity, entity_id, op, payload, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (entity, entity_id, op) where synced_at is null
     do update set payload = excluded.payload, attempts = 0, last_error = null`,
    [entity, entityId, op, JSON.stringify(payload), now],
  );
}

/** Pending mutations in the order they must be applied. */
export function pending(db: SqlDb, limit = 200): OutboxRow[] {
  return db.all<OutboxRow>(
    'select * from outbox where synced_at is null order by seq limit ?',
    [limit],
  );
}

export function markSynced(db: SqlDb, seqs: readonly number[], now: string): void {
  for (const seq of seqs) {
    db.run('update outbox set synced_at = ?, last_error = null where seq = ?', [now, seq]);
  }
}

export function markFailed(db: SqlDb, seq: number, error: string): void {
  db.run(
    'update outbox set attempts = attempts + 1, last_error = ? where seq = ?',
    [error.slice(0, 500), seq],
  );
}

/** Drop synced rows older than the cutoff so the queue does not grow forever. */
export function pruneOutbox(db: SqlDb, before: string): number {
  const row = db.get<{ n: number }>(
    'select count(*) as n from outbox where synced_at is not null and synced_at < ?',
    [before],
  );
  db.run('delete from outbox where synced_at is not null and synced_at < ?', [before]);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Workout writes
// ---------------------------------------------------------------------------

export interface StartWorkoutInput {
  id: string;
  routineId: string | null;
  startedAt: string;
}

export function startWorkout(db: SqlDb, input: StartWorkoutInput): void {
  db.run('insert into workouts (id, routine_id, started_at) values (?, ?, ?)', [
    input.id,
    input.routineId,
    input.startedAt,
  ]);
  enqueue(db, 'workout', input.id, 'upsert', input, input.startedAt);
}

export function finishWorkout(db: SqlDb, id: string, endedAt: string): void {
  db.run('update workouts set status = ?, ended_at = ? where id = ?', ['completed', endedAt, id]);
  enqueue(db, 'workout', id, 'upsert', { id, status: 'completed', endedAt }, endedAt);
}

export interface AddExerciseInput {
  id: string;
  workoutId: string;
  exerciseId: string;
  swappedFromExerciseId: string | null;
  orderIndex: number;
  at: string;
}

export function addWorkoutExercise(db: SqlDb, input: AddExerciseInput): void {
  db.run(
    `insert into workout_exercises
       (id, workout_id, exercise_id, swapped_from_exercise_id, order_index)
     values (?, ?, ?, ?, ?)
     on conflict (id) do update set
       exercise_id = excluded.exercise_id,
       swapped_from_exercise_id = excluded.swapped_from_exercise_id,
       order_index = excluded.order_index`,
    [input.id, input.workoutId, input.exerciseId, input.swappedFromExerciseId, input.orderIndex],
  );
  enqueue(db, 'workout_exercise', input.id, 'upsert', input, input.at);
}

export interface LogSetInput {
  id: string;
  workoutExerciseId: string;
  exerciseId: string;
  setIndex: number;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  isWarmup: boolean;
  completedAt: string;
}

/**
 * Record a completed set.
 *
 * The write and its outbox row happen together, so a crash between them cannot
 * leave a logged set that will never reach the server. `client_seq` is a
 * monotonic counter scoped to the device, giving the server a total order to
 * reconcile against without trusting device clocks.
 */
export function logSet(db: SqlDb, input: LogSetInput): void {
  const next = db.get<{ n: number }>('select coalesce(max(client_seq), 0) + 1 as n from sets');
  const clientSeq = next?.n ?? 1;

  db.run(
    `insert into sets
       (id, workout_exercise_id, exercise_id, set_index, weight_kg, reps, rpe,
        is_warmup, completed_at, client_seq)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (workout_exercise_id, set_index) do update set
       weight_kg = excluded.weight_kg,
       reps = excluded.reps,
       rpe = excluded.rpe,
       completed_at = excluded.completed_at`,
    [
      input.id,
      input.workoutExerciseId,
      input.exerciseId,
      input.setIndex,
      input.weightKg,
      input.reps,
      input.rpe,
      input.isWarmup ? 1 : 0,
      input.completedAt,
      clientSeq,
    ],
  );
  enqueue(db, 'set', input.id, 'upsert', { ...input, clientSeq }, input.completedAt);
}

export function removeSet(db: SqlDb, id: string, at: string): void {
  db.run('delete from sets where id = ?', [id]);
  enqueue(db, 'set', id, 'delete', { id }, at);
}

// ---------------------------------------------------------------------------
// History reads — what feeds the predictor
// ---------------------------------------------------------------------------

interface SetHistoryRow {
  workout_exercise_id: string;
  set_index: number;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  is_warmup: number;
  completed_at: string;
}

/**
 * Past sessions for one exercise, newest last, ready for
 * `buildProgressionState`.
 *
 * Sessions are grouped by `workout_exercise_id` rather than by calendar day:
 * two sessions on the same date are two sessions, and one session spanning
 * midnight is still one.
 */
export function historyFor(db: SqlDb, exerciseId: string, limitSessions = 10): SessionRecord[] {
  const rows = db.all<SetHistoryRow>(
    `select workout_exercise_id, set_index, weight_kg, reps, rpe, is_warmup, completed_at
       from sets
      where exercise_id = ? and is_warmup = 0
      order by completed_at asc`,
    [exerciseId],
  );

  const grouped = new Map<string, SetRecord[]>();
  const sessionAt = new Map<string, string>();

  for (const row of rows) {
    const key = row.workout_exercise_id;
    if (!grouped.has(key)) {
      grouped.set(key, []);
      sessionAt.set(key, row.completed_at);
    }
    grouped.get(key)!.push({
      setIndex: row.set_index,
      weightKg: row.weight_kg,
      reps: row.reps,
      rpe: row.rpe,
      isWarmup: row.is_warmup === 1,
      completedAt: row.completed_at,
    });
  }

  const sessions = [...grouped.entries()].map(([key, sets]) => ({
    at: sessionAt.get(key)!,
    sets,
  }));

  return sessions.slice(-limitSessions);
}

/** Exercise ids the user has any logged history for — drives the swap re-rank boost. */
export function exercisesWithHistory(db: SqlDb): Set<string> {
  const rows = db.all<{ exercise_id: string }>(
    'select distinct exercise_id from sets where is_warmup = 0',
  );
  return new Set(rows.map((r) => r.exercise_id));
}

// ---------------------------------------------------------------------------
// Saved routines
// ---------------------------------------------------------------------------

/**
 * Routines are device-local and do not enter the outbox.
 *
 * A workout is a fact that has to reach the server — it is history, and losing
 * it loses training data the predictor depends on. A routine is a preference:
 * cheap to recreate, meaningless to anyone but its owner, and already durable
 * on the server in the one case where it came from somebody else. Queueing them
 * would mean a `routines` sync path, a conflict policy for two devices editing
 * the same routine, and a server round trip on a screen that has no reason to
 * wait for one.
 *
 * The consequence to be honest about: a reinstall loses locally-written
 * routines. That is the open item in `docs/HANDOFF.md`, not an oversight.
 */

export type RoutineSource = 'mine' | 'friend' | 'link';

export interface StoredRoutineExercise {
  exerciseId: string;
  sets: number;
  reps: number;
  /** Null means "use my own rest settings for this exercise's type". */
  restS: number | null;
}

export interface StoredRoutine {
  id: string;
  title: string;
  note: string | null;
  source: RoutineSource;
  fromHandle: string | null;
  createdAt: string;
  lastRunAt: string | null;
  exercises: StoredRoutineExercise[];
}

export interface RoutineSummary {
  id: string;
  title: string;
  note: string | null;
  source: RoutineSource;
  fromHandle: string | null;
  createdAt: string;
  lastRunAt: string | null;
  exerciseCount: number;
}

export type SaveRoutineInput = Omit<StoredRoutine, 'lastRunAt'>;

/**
 * Write a routine, replacing whatever it held before.
 *
 * The exercise rows are deleted and reinserted rather than diffed. Order index
 * is half the primary key, so an in-place update of a reordered routine would
 * collide with rows that have not moved yet — and a routine is at most 24 rows,
 * where a diff costs more to read than it saves to run.
 */
export function saveRoutine(db: SqlDb, input: SaveRoutineInput): void {
  db.run(
    `insert into saved_routines (id, title, note, source, from_handle, created_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       title = excluded.title,
       note = excluded.note,
       source = excluded.source,
       from_handle = excluded.from_handle`,
    [input.id, input.title, input.note, input.source, input.fromHandle, input.createdAt],
  );

  db.run('delete from saved_routine_exercises where routine_id = ?', [input.id]);

  input.exercises.forEach((exercise, index) => {
    db.run(
      `insert into saved_routine_exercises
         (routine_id, order_index, exercise_id, sets, reps, rest_s)
       values (?, ?, ?, ?, ?, ?)`,
      [input.id, index, exercise.exerciseId, exercise.sets, exercise.reps, exercise.restS],
    );
  });
}

interface RoutineRow {
  id: string;
  title: string;
  note: string | null;
  source: RoutineSource;
  from_handle: string | null;
  created_at: string;
  last_run_at: string | null;
}

interface RoutineExerciseRow {
  exercise_id: string;
  sets: number;
  reps: number;
  rest_s: number | null;
}

/** Most recently used first, then most recently added. */
export function listRoutines(db: SqlDb): RoutineSummary[] {
  const rows = db.all<RoutineRow & { exercise_count: number }>(
    `select r.*, count(e.exercise_id) as exercise_count
       from saved_routines r
       left join saved_routine_exercises e on e.routine_id = r.id
      group by r.id
      order by coalesce(r.last_run_at, r.created_at) desc`,
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    source: row.source,
    fromHandle: row.from_handle,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    exerciseCount: row.exercise_count,
  }));
}

export function getRoutine(db: SqlDb, id: string): StoredRoutine | null {
  const row = db.get<RoutineRow>('select * from saved_routines where id = ?', [id]);
  if (!row) return null;

  const exercises = db.all<RoutineExerciseRow>(
    `select exercise_id, sets, reps, rest_s
       from saved_routine_exercises
      where routine_id = ?
      order by order_index`,
    [id],
  );

  return {
    id: row.id,
    title: row.title,
    note: row.note,
    source: row.source,
    fromHandle: row.from_handle,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    exercises: exercises.map((e) => ({
      exerciseId: e.exercise_id,
      sets: e.sets,
      reps: e.reps,
      restS: e.rest_s,
    })),
  };
}

export function deleteRoutine(db: SqlDb, id: string): void {
  db.run('delete from saved_routine_exercises where routine_id = ?', [id]);
  db.run('delete from saved_routines where id = ?', [id]);
}

/** Sorts the list by what the user actually trains, rather than what they saved. */
export function markRoutineRun(db: SqlDb, id: string, at: string): void {
  db.run('update saved_routines set last_run_at = ? where id = ?', [at, id]);
}
