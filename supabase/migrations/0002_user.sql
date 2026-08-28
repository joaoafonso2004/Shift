-- Shift 0002 — user profile, routines and training history.

create table profiles (
  id                  uuid primary key references auth.users on delete cascade,
  display_name        text,
  unit_system         text not null default 'metric',
  default_rest_s      int not null default 90,
  haptic_intensity    smallint not null default 2,
  reduce_motion       boolean not null default false,
  available_equipment text[] not null default '{}',
  bar_weight_kg       numeric(5,2) not null default 20,
  created_at          timestamptz not null default now()
);

create table routines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  name        text not null,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create table routine_exercises (
  id          uuid primary key default gen_random_uuid(),
  routine_id  uuid not null references routines(id) on delete cascade,
  exercise_id text not null references exercises(id),
  order_index smallint not null,
  target_sets smallint not null default 3,
  rest_s      int
);

create index routine_exercises_routine_idx on routine_exercises (routine_id, order_index);

create table workouts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  routine_id      uuid references routines(id) on delete set null,
  sync_session_id uuid,
  status          text not null default 'active',
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  total_volume_kg numeric(10,2),
  -- Idempotency key generated on device before the workout ever reaches the
  -- network. Replaying the outbox after a failed flush must not create a second
  -- workout, and the device is the only thing that knows they are the same one.
  client_id       text not null,
  unique (user_id, client_id)
);

create index workouts_user_started_idx on workouts (user_id, started_at desc);

create table workout_exercises (
  id                       uuid primary key default gen_random_uuid(),
  workout_id               uuid not null references workouts(id) on delete cascade,
  exercise_id              text not null references exercises(id),
  swapped_from_exercise_id text references exercises(id),
  order_index              smallint not null,
  client_id                text not null,
  created_at               timestamptz not null default now(),
  unique (workout_id, client_id)
);

create index workout_exercises_workout_idx on workout_exercises (workout_id, order_index);

-- The hot table. Every logged set, forever.
create table sets (
  id                  uuid primary key default gen_random_uuid(),
  workout_exercise_id uuid not null references workout_exercises(id) on delete cascade,
  -- Denormalised so RLS on the hot path is a bare `user_id = auth.uid()` check
  -- and the progression query is one index scan. This is a performance decision
  -- as much as a security one.
  user_id             uuid not null references profiles(id) on delete cascade,
  exercise_id         text not null references exercises(id),
  set_index           smallint not null,
  weight_kg           numeric(6,2),
  reps                smallint,
  rpe                 numeric(3,1),
  is_warmup           boolean not null default false,
  -- Epley, capped at 12 reps. The client mirrors this exactly; beyond ~12 the
  -- estimate degrades badly and a client disagreeing with the database about a
  -- PR is worse than no estimate.
  e1rm numeric(6,2) generated always as (
    case
      when weight_kg is not null and reps is not null and reps between 1 and 12
      then weight_kg * (1 + reps / 30.0)
      else null
    end
  ) stored,
  completed_at        timestamptz not null default now(),
  client_seq          bigint not null,
  unique (workout_exercise_id, set_index)
);

create index sets_progression_idx on sets (user_id, exercise_id, completed_at desc);

-- Trigger-maintained prediction feed. A table rather than a view because the
-- predictor must answer in under a millisecond during card mount.
create table exercise_progression (
  user_id              uuid not null references profiles(id) on delete cascade,
  exercise_id          text not null references exercises(id),
  last_session_at      timestamptz not null,
  last_sets            jsonb not null default '[]',
  best_e1rm            numeric(6,2),
  best_e1rm_at         timestamptz,
  session_count        int not null default 0,
  trend_kg_per_session numeric(5,2),
  -- Not derivable from last_sets: choosing between "retry" and "deload" needs
  -- memory further back than one session, and making the client walk history to
  -- find out would put a multi-session query on the card-mount path.
  consecutive_failures smallint not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

create table personal_records (
  user_id     uuid not null references profiles(id) on delete cascade,
  exercise_id text not null references exercises(id),
  metric      text not null,
  value       numeric(8,2) not null,
  achieved_at timestamptz not null default now(),
  set_id      uuid references sets(id) on delete set null,
  primary key (user_id, exercise_id, metric)
);
