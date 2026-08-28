-- Shift 0005 — row level security.
--
-- The policy on `sets` is deliberately the simplest possible check. It is the
-- hot table, and squadmates read each other's *progress* through sync_members
-- and sync_events rather than through raw set rows — which is what keeps squad
-- size off the write path entirely.

alter table profiles             enable row level security;
alter table routines             enable row level security;
alter table routine_exercises    enable row level security;
alter table workouts             enable row level security;
alter table workout_exercises    enable row level security;
alter table sets                 enable row level security;
alter table exercise_progression enable row level security;
alter table personal_records     enable row level security;
alter table sync_sessions        enable row level security;
alter table sync_stations        enable row level security;
alter table sync_members         enable row level security;
alter table station_turn_plan    enable row level security;
alter table sync_events          enable row level security;

create policy profiles_own on profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy routines_own on routines
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy routine_exercises_own on routine_exercises
  for all to authenticated
  using (exists (select 1 from routines r where r.id = routine_id and r.user_id = auth.uid()))
  with check (exists (select 1 from routines r where r.id = routine_id and r.user_id = auth.uid()));

create policy workouts_own on workouts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy workout_exercises_own on workout_exercises
  for all to authenticated
  using (exists (select 1 from workouts w where w.id = workout_id and w.user_id = auth.uid()))
  with check (exists (select 1 from workouts w where w.id = workout_id and w.user_id = auth.uid()));

create policy sets_own on sets
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy exercise_progression_own on exercise_progression
  for select to authenticated using (user_id = auth.uid());

create policy personal_records_own on personal_records
  for select to authenticated using (user_id = auth.uid());

-- Co-op. Membership checks go through the security-definer helper because a
-- self-referential policy on sync_members recurses.
create policy sync_sessions_member on sync_sessions
  for select to authenticated using (is_session_member(id));

create policy sync_sessions_create on sync_sessions
  for insert to authenticated with check (host_user_id = auth.uid());

create policy sync_members_read on sync_members
  for select to authenticated using (is_session_member(session_id));

create policy sync_members_join on sync_members
  for insert to authenticated with check (user_id = auth.uid());

create policy sync_members_self_update on sync_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy sync_members_leave on sync_members
  for delete to authenticated using (user_id = auth.uid());

-- No direct write policy on stations: turn state moves only through
-- advance_turn(), which is security definer and enforces membership itself.
create policy sync_stations_read on sync_stations
  for select to authenticated using (is_session_member(session_id));

create policy station_turn_plan_read on station_turn_plan
  for select to authenticated
  using (exists (select 1 from sync_stations st
                  where st.id = station_id and is_session_member(st.session_id)));

create policy sync_events_read on sync_events
  for select to authenticated using (is_session_member(session_id));

create policy sync_events_append on sync_events
  for insert to authenticated
  with check (actor_user_id = auth.uid() and is_session_member(session_id));
