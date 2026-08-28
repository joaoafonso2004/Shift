-- Shift 0004 — functions and triggers.

-- A self-referential RLS policy on the membership table recurses. Routing the
-- check through a security-definer helper is mandatory, not stylistic.
create function is_session_member(p_session uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from sync_members
     where session_id = p_session and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Progression feed
-- ---------------------------------------------------------------------------

-- Reference implementation lives in src/domain/progression.ts and is unit
-- tested there; this must agree with it. Epley's 12-rep cap and the definition
-- of a "failed" session are the two places they could silently diverge.
create function refresh_progression() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rep_floor  smallint := 8;
  v_last_at    timestamptz;
  v_last_sets  jsonb;
  v_hit_target boolean;
  v_failures   smallint;
begin
  if new.is_warmup then
    return new;
  end if;

  select max(s.completed_at) into v_last_at
    from sets s
   where s.user_id = new.user_id and s.exercise_id = new.exercise_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'set_index', s.set_index,
           'weight_kg', s.weight_kg,
           'reps', s.reps,
           'rpe', s.rpe
         ) order by s.set_index), '[]')
    into v_last_sets
    from sets s
   where s.workout_exercise_id = new.workout_exercise_id
     and s.is_warmup = false;

  select bool_and(coalesce(s.reps, 0) >= v_rep_floor) into v_hit_target
    from sets s
   where s.workout_exercise_id = new.workout_exercise_id
     and s.is_warmup = false;

  select case when coalesce(v_hit_target, false)
              then 0
              else coalesce(p.consecutive_failures, 0) + 1 end
    into v_failures
    from (select 1) dummy
    left join exercise_progression p
      on p.user_id = new.user_id and p.exercise_id = new.exercise_id;

  insert into exercise_progression as ep (
    user_id, exercise_id, last_session_at, last_sets,
    best_e1rm, best_e1rm_at, session_count, consecutive_failures, updated_at
  )
  values (
    new.user_id, new.exercise_id, v_last_at, v_last_sets,
    new.e1rm, new.completed_at, 1, coalesce(v_failures, 0), now()
  )
  on conflict (user_id, exercise_id) do update set
    last_session_at = excluded.last_session_at,
    last_sets       = excluded.last_sets,
    best_e1rm       = greatest(coalesce(ep.best_e1rm, 0), coalesce(new.e1rm, 0)),
    best_e1rm_at    = case
                        when new.e1rm is not null
                         and new.e1rm > coalesce(ep.best_e1rm, 0)
                        then new.completed_at
                        else ep.best_e1rm_at
                      end,
    consecutive_failures = coalesce(v_failures, 0),
    updated_at      = now();

  -- Detected here rather than on the client so the celebration can be pushed
  -- the instant the set commits.
  if new.e1rm is not null then
    insert into personal_records (user_id, exercise_id, metric, value, achieved_at, set_id)
    values (new.user_id, new.exercise_id, 'e1rm', new.e1rm, new.completed_at, new.id)
    on conflict (user_id, exercise_id, metric) do update set
      value = excluded.value,
      achieved_at = excluded.achieved_at,
      set_id = excluded.set_id
    where excluded.value > personal_records.value;
  end if;

  return new;
end;
$$;

create trigger sets_refresh_progression
  after insert on sets
  for each row execute function refresh_progression();

-- ---------------------------------------------------------------------------
-- Turn rotation
-- ---------------------------------------------------------------------------

-- Honours the station's direction and skips members who have gone away or
-- stalled. The squad is never blocked on one phone.
create function next_in_rotation(p_station uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_direction smallint;
  v_active    uuid;
  v_pos       smallint;
  v_next      uuid;
begin
  select direction, active_user_id into v_direction, v_active
    from sync_stations where id = p_station;

  if v_active is null then
    select user_id into v_next from sync_members
     where station_id = p_station and state not in ('away', 'stalled')
     order by queue_pos limit 1;
    return v_next;
  end if;

  select queue_pos into v_pos from sync_members
   where station_id = p_station and user_id = v_active;

  if v_direction >= 0 then
    select user_id into v_next from sync_members
     where station_id = p_station and queue_pos > v_pos
       and state not in ('away', 'stalled')
     order by queue_pos limit 1;
  else
    select user_id into v_next from sync_members
     where station_id = p_station and queue_pos < v_pos
       and state not in ('away', 'stalled')
     order by queue_pos desc limit 1;
  end if;

  -- Round boundary: wrap to whichever end the direction implies.
  if v_next is null then
    if v_direction >= 0 then
      select user_id into v_next from sync_members
       where station_id = p_station and state not in ('away', 'stalled')
       order by queue_pos limit 1;
    else
      select user_id into v_next from sync_members
       where station_id = p_station and state not in ('away', 'stalled')
       order by queue_pos desc limit 1;
    end if;
  end if;

  return v_next;
end;
$$;

create function turn_budget_s(p_station uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(m.avg_work_s), 40) * 3
    from sync_members m where m.station_id = p_station;
$$;

-- Compare-and-swap turn advancement.
--
-- The loser gets a serialization_failure, refetches, and reconciles — it never
-- retries blindly. `turn_cursor` doubles as the ordering token for Realtime: a
-- client holding a higher cursor discards a stale broadcast, which makes
-- out-of-order delivery a non-issue with no client-side sequencing logic.
create function advance_turn(p_station uuid, p_expected_cursor bigint)
returns sync_stations
language plpgsql security definer set search_path = public as $$
declare
  s sync_stations;
begin
  if not is_session_member((select session_id from sync_stations where id = p_station)) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  update sync_stations
     set turn_cursor      = turn_cursor + 1,
         active_user_id   = next_in_rotation(p_station),
         turn_started_at  = now(),
         turn_deadline_at = now() + make_interval(secs => turn_budget_s(p_station))
   where id = p_station and turn_cursor = p_expected_cursor
   returning * into s;

  if not found then
    raise exception 'stale_cursor' using errcode = '40001';
  end if;

  insert into sync_events (session_id, station_id, actor_user_id, type, payload)
  values (s.session_id, s.id, auth.uid(), 'turn_advanced',
          jsonb_build_object('cursor', s.turn_cursor, 'active', s.active_user_id));

  return s;
end;
$$;

-- Clock offset measurement for the shared rest timers. Clients call this three
-- times on join and keep the sample with the lowest round trip, which aligns
-- devices to roughly 20-50ms without exchanging another packet afterwards.
create function server_now() returns timestamptz
language sql stable as $$ select now(); $$;
