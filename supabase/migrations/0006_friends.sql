-- Shift 0006 — friendships, profiles and avatars.

alter table profiles
  add column handle text unique,
  add column avatar_path text,
  add column bio text,
  add column privacy jsonb not null default
    '{"discoverable":true,"shareWorkoutCount":true,"shareStreak":true,
      "shareMuscleSplit":true,"sharePersonalRecords":true,"shareAbsoluteWeights":false}';

-- Handles are matched case-insensitively but stored as typed.
create unique index profiles_handle_lower_idx on profiles (lower(handle));

-- One row per relationship, never one per direction.
--
-- A row per direction means every accept, block and unfriend has to update two
-- rows, and the first time one write lands and the other does not you get a
-- friendship that exists for one person and not the other. `user_a` is always
-- the smaller id; direction lives in `actor_id`.
create table friendships (
  user_a       uuid not null references profiles(id) on delete cascade,
  user_b       uuid not null references profiles(id) on delete cascade,
  state        text not null check (state in ('pending', 'accepted', 'blocked')),
  -- Who sent the request, or who applied the block.
  actor_id     uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (user_a, user_b),
  -- Enforces the canonical ordering at the database level, so a client that
  -- forgets to sort cannot create the duplicate this table exists to prevent.
  constraint friendships_ordered check (user_a < user_b),
  constraint friendships_actor_is_party check (actor_id in (user_a, user_b))
);

create index friendships_user_b_idx on friendships (user_b);
create index friendships_state_idx on friendships (state);

-- Security definer, because a policy on `profiles` that reads `friendships`
-- which in turn reads `profiles` would recurse.
create function are_friends(p_other uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from friendships f
     where f.state = 'accepted'
       and ((f.user_a = auth.uid() and f.user_b = p_other)
         or (f.user_b = auth.uid() and f.user_a = p_other))
  );
$$;

create function is_blocked_with(p_other uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from friendships f
     where f.state = 'blocked'
       and ((f.user_a = auth.uid() and f.user_b = p_other)
         or (f.user_b = auth.uid() and f.user_a = p_other))
  );
$$;

-- ---------------------------------------------------------------------------
-- Shareable stats
-- ---------------------------------------------------------------------------

-- Maintained alongside the workout log so a friend's profile is one indexed
-- read rather than an aggregate over someone else's entire history — which RLS
-- would not let them run anyway.
create table friend_stats (
  user_id           uuid primary key references profiles(id) on delete cascade,
  workouts_total    int not null default 0,
  workouts_this_week int not null default 0,
  streak_weeks      int not null default 0,
  muscle_split      jsonb not null default '{}',
  last_workout_at   timestamptz,
  updated_at        timestamptz not null default now()
);

-- Personal records as *events*. The value column exists for the owner's own
-- history; whether a friend sees it is gated by `shareAbsoluteWeights`, which
-- is off by default. "Hit a new bench best" is motivating; "benches 120kg" next
-- to a friend who benches 60 is not.
create table record_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  exercise_id   text not null references exercises(id),
  improvement_pct numeric(5,2),
  achieved_at   timestamptz not null default now()
);

create index record_events_user_idx on record_events (user_id, achieved_at desc);

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------

-- The moment photos are visible to anyone else, somebody uploads something they
-- should not. A report path is the minimum; automated moderation is still open
-- (see docs/HANDOFF.md).
create table user_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references profiles(id) on delete cascade,
  reported_id  uuid not null references profiles(id) on delete cascade,
  reason       text not null,
  detail       text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  unique (reporter_id, reported_id)
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table friendships   enable row level security;
alter table friend_stats  enable row level security;
alter table record_events enable row level security;
alter table user_reports  enable row level security;

create policy friendships_read on friendships
  for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- You may only create a row you are part of, and only as the actor. Without the
-- actor check, one user could insert a request that appears to come from
-- somebody else.
create policy friendships_create on friendships
  for insert to authenticated
  with check (auth.uid() in (user_a, user_b) and actor_id = auth.uid());

create policy friendships_respond on friendships
  for update to authenticated
  using (auth.uid() in (user_a, user_b))
  with check (auth.uid() in (user_a, user_b));

create policy friendships_remove on friendships
  for delete to authenticated
  using (auth.uid() in (user_a, user_b));

-- A profile is visible to its owner, to accepted friends, and — only when the
-- owner is discoverable — as a bare handle for search. Blocking wins over all
-- of it.
create policy profiles_self on profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_friends on profiles
  for select to authenticated
  using (are_friends(id) and not is_blocked_with(id));

create policy profiles_discoverable on profiles
  for select to authenticated
  using ((privacy->>'discoverable')::boolean is true and not is_blocked_with(id));

create policy friend_stats_own on friend_stats
  for select to authenticated using (user_id = auth.uid());

create policy friend_stats_friends on friend_stats
  for select to authenticated
  using (are_friends(user_id) and not is_blocked_with(user_id));

create policy record_events_own on record_events
  for select to authenticated using (user_id = auth.uid());

create policy record_events_friends on record_events
  for select to authenticated
  using (are_friends(user_id) and not is_blocked_with(user_id));

create policy user_reports_create on user_reports
  for insert to authenticated with check (reporter_id = auth.uid());

create policy user_reports_read_own on user_reports
  for select to authenticated using (reporter_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Avatar storage
-- ---------------------------------------------------------------------------

-- A **private** bucket. Public would mean a profile photo is readable by anyone
-- holding the URL, forever, whatever the friendship says — and "you can see
-- your friends'" has to mean something. The cost is that reads go through
-- signed URLs, so the client fetches them in batches and caches them; see
-- src/data/avatars.ts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Objects are stored at `<user_id>/avatar.jpg`, so ownership is the path prefix.
create policy avatars_own_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or are_friends(((storage.foldername(name))[1])::uuid)
    )
  );
