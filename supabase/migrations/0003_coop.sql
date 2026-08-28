-- Shift 0003 — Sync Session: squads of 2 to 4.
--
-- Three things break when a pair becomes a squad, and this schema answers all
-- three: rest stops being one shared number, turn state gets contended, and a
-- squad of four rarely shares one bar.

create table sync_sessions (
  id            uuid primary key default gen_random_uuid(),
  -- A display label, not authority. All authority lives in the functions in
  -- 0004, so host failover is a label change and never a state transfer.
  host_user_id  uuid not null references profiles(id) on delete cascade,
  join_code     text not null unique,
  status        text not null default 'open',
  max_members   smallint not null default 4 check (max_members between 2 and 4),
  bar_weight_kg    numeric(5,2) not null default 20,
  plate_inventory  jsonb not null default
    '{"25":4,"20":4,"15":2,"10":4,"5":4,"2.5":4,"1.25":2}',
  min_increment_kg numeric(4,2) not null default 1.25,
  pacing_mode      text not null default 'auto',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '6 hours'
);

-- The unit of rotation. A squad of four usually splits 2+2 rather than queueing
-- on one bar, so stations belong to the session, not the other way round.
create table sync_stations (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sync_sessions(id) on delete cascade,
  exercise_id text not null references exercises(id),
  order_index smallint not null,
  -- Mutated only through advance_turn(). Two clients racing on "I'm done" is
  -- survivable; four colliding at a round boundary is not.
  turn_cursor      bigint not null default 0,
  active_user_id   uuid references profiles(id),
  turn_started_at  timestamptz,
  turn_deadline_at timestamptz,
  round_index      smallint not null default 0,
  direction        smallint not null default 1,
  loaded_kg        numeric(6,2),
  plan_version     int not null default 0,
  unique (session_id, order_index)
);

create table sync_members (
  session_id uuid not null references sync_sessions(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  workout_id uuid references workouts(id) on delete set null,
  station_id uuid references sync_stations(id) on delete set null,
  role       text not null default 'member',
  -- 0..3 because the client preallocates exactly four shared-value slots at
  -- mount. Hooks are fixed-count, so a dynamically sized squad cannot mean
  -- dynamically sized shared values: this constraint serves the render tree.
  color_slot smallint not null check (color_slot between 0 and 3),
  queue_pos  smallint not null,
  state      text not null default 'idle',
  current_set_index  smallint not null default 0,
  target_sets        smallint,
  planned_load_kg    numeric(6,2),
  planned_reps       smallint,
  -- planned_load / best_e1rm. The squad rail displays this rather than kilos:
  -- four friends of different bodyweights showing raw numbers side by side
  -- turns training into a leaderboard.
  relative_intensity numeric(4,3),
  avg_work_s         smallint not null default 40,
  rest_target_s      int not null default 90,
  -- Per member. There is no session-level timer: at N > 2 every member's rest
  -- is a different interval ending at a different time.
  rest_ends_at       timestamptz,
  last_seen_at       timestamptz not null default now(),
  primary key (session_id, user_id),
  unique (session_id, color_slot)
);

create index sync_members_station_idx on sync_members (station_id, queue_pos);

-- Computed server-side so all N clients agree on one plan instead of each
-- deriving its own from replicated inputs that may be a message apart.
create table station_turn_plan (
  station_id   uuid not null references sync_stations(id) on delete cascade,
  round_index  smallint not null,
  slot         smallint not null,
  user_id      uuid not null references profiles(id),
  load_kg      numeric(6,2) not null,
  plate_delta  jsonb not null,
  transition_s smallint not null,
  primary key (station_id, round_index, slot)
);

-- Append-only, ordered, replayable. Survives reconnects and host handover.
create table sync_events (
  seq           bigint generated always as identity primary key,
  session_id    uuid not null references sync_sessions(id) on delete cascade,
  station_id    uuid references sync_stations(id) on delete cascade,
  actor_user_id uuid not null references profiles(id),
  type          text not null,
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index sync_events_replay_idx on sync_events (session_id, seq);

alter table workouts
  add constraint workouts_sync_session_fk
  foreign key (sync_session_id) references sync_sessions(id) on delete set null;
