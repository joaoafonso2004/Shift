/**
 * Device-local database: the source of truth the UI reads from.
 *
 * Shift is offline-first because gyms have bad signal. A completed set is
 * written here and rendered from here; the network is a background concern that
 * the interface never waits on. Supabase is the ledger, this is the workbench.
 *
 * The schema is a plain string so the same DDL runs under `expo-sqlite` on
 * device and under `node:sqlite` in the test suite — the tests exercise the real
 * queries against the real engine rather than a mock.
 */

export const LOCAL_SCHEMA = `
pragma foreign_keys = on;

create table if not exists workouts (
  id          text primary key,
  routine_id  text,
  status      text not null default 'active',
  started_at  text not null,
  ended_at    text,
  synced_at   text
);

create table if not exists workout_exercises (
  id                       text primary key,
  workout_id               text not null references workouts(id) on delete cascade,
  exercise_id              text not null,
  swapped_from_exercise_id text,
  order_index              integer not null
);

create index if not exists workout_exercises_workout_idx
  on workout_exercises (workout_id, order_index);

create table if not exists sets (
  id                  text primary key,
  workout_exercise_id text not null references workout_exercises(id) on delete cascade,
  exercise_id         text not null,
  set_index           integer not null,
  weight_kg           real,
  reps                integer,
  rpe                 real,
  is_warmup           integer not null default 0,
  completed_at        text not null,
  client_seq          integer not null,
  unique (workout_exercise_id, set_index)
);

create index if not exists sets_history_idx on sets (exercise_id, completed_at desc);

-- Routines this device can run: written by the user, received from a friend, or
-- opened from a link.
--
-- A received routine is copied here at the moment it is accepted rather than
-- read back from the server each time. The sender can edit or delete theirs
-- afterwards and yours does not change — which is the whole difference between
-- being sent something and being given a view of somebody else's data.
create table if not exists saved_routines (
  id           text primary key,
  title        text not null,
  note         text,
  -- 'mine' | 'friend' | 'link'. Drives attribution, not behaviour.
  source       text not null default 'mine',
  from_handle  text,
  created_at   text not null,
  last_run_at  text
);

create table if not exists saved_routine_exercises (
  routine_id  text not null references saved_routines(id) on delete cascade,
  order_index integer not null,
  exercise_id text not null,
  sets        integer not null default 3,
  reps        integer not null default 8,
  -- Null means "use my own rest settings". Only a rest the sender deliberately
  -- prescribed is stored, so a receiver's compound/isolation defaults still win
  -- everywhere one was not.
  rest_s      integer,
  primary key (routine_id, order_index)
);

-- Durable mutation queue. Rows are appended as facts happen and drained in seq
-- order, so a flush interrupted halfway leaves the queue consistent rather than
-- half-applied.
create table if not exists outbox (
  seq        integer primary key autoincrement,
  entity     text not null,
  entity_id  text not null,
  op         text not null,
  payload    text not null,
  created_at text not null,
  attempts   integer not null default 0,
  last_error text,
  synced_at  text
);

create index if not exists outbox_pending_idx on outbox (synced_at, seq);
-- One pending upsert per entity: repeated edits to the same set coalesce rather
-- than queueing a row each time.
create unique index if not exists outbox_pending_unique_idx
  on outbox (entity, entity_id, op) where synced_at is null;
`;

/**
 * The slice of a SQLite driver this layer needs.
 *
 * `expo-sqlite` and `node:sqlite` have different APIs but the same engine.
 * Adapting both to this interface is what lets the tests run the production
 * queries on Windows, with no device and no mock.
 */
export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, params?: readonly unknown[]): void;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | null;
}

export function initLocalDb(db: SqlDb): void {
  db.exec(LOCAL_SCHEMA);
}
