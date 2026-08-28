-- Shift 0008 — sending a routine to a friend.
--
-- The payload is stored as jsonb rather than as rows in `routine_exercises`,
-- and that is deliberate. A sent routine is a *message*, not a record: it has to
-- survive the sender editing their own routine afterwards, or deleting it
-- outright, without the thing you received changing under you. Normalising it
-- would make every share a live view of somebody else's mutable data.
--
-- Nothing here can carry a load. `SharedExercise` in src/domain/sharing.ts has
-- no weight field, so there is none in the payload — invariant 13 holds by the
-- shape of the type rather than by a filter on the way out.

-- The routine table predates the share format and only prescribed sets and
-- rest. A shared routine prescribes reps too, and defaulting them at import
-- would throw away the one thing the sender was most likely to have chosen.
alter table routine_exercises add column target_reps smallint not null default 8;

create table shared_routines (
  id           uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references profiles(id) on delete cascade,
  to_user_id   uuid not null references profiles(id) on delete cascade,
  payload      jsonb not null,
  message      text,
  state        text not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,

  constraint shared_routines_state_check
    check (state in ('pending', 'accepted', 'dismissed')),
  constraint shared_routines_not_self
    check (from_user_id <> to_user_id),
  -- A bound the client cannot argue with. The domain caps a routine at 24
  -- exercises, which is nowhere near this; anything approaching it is not a
  -- routine.
  constraint shared_routines_payload_size
    check (length(payload::text) <= 8192),
  constraint shared_routines_message_length
    check (message is null or length(message) <= 280)
);

-- The inbox query: everything pending, for me, newest first.
create index shared_routines_inbox_idx
  on shared_routines (to_user_id, state, created_at desc);

create index shared_routines_sent_idx
  on shared_routines (from_user_id, created_at desc);

-- The same routine cannot sit in someone's inbox twice.
--
-- Sending again after they accepted or dismissed is fine — that is a person
-- choosing to resend. What this stops is a tap that fires twice, and the
-- nuisance case of the same routine pushed at someone repeatedly while they
-- have not answered.
create unique index shared_routines_pending_unique_idx
  on shared_routines (from_user_id, to_user_id, md5(payload::text))
  where state = 'pending';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table shared_routines enable row level security;

-- Both sides can see it: the recipient needs the inbox, and the sender needs to
-- know whether it was taken up.
create policy shared_routines_read on shared_routines
  for select to authenticated
  using (auth.uid() in (from_user_id, to_user_id));

-- You may only send as yourself, only to a friend, and never across a block.
--
-- The friendship check is what keeps this from becoming an open channel to any
-- account whose id you can guess. It is enforced here rather than only in the
-- client because a policy is the only version of this rule that a hand-rolled
-- request cannot skip.
create policy shared_routines_send on shared_routines
  for insert to authenticated
  with check (
    from_user_id = auth.uid()
    and are_friends(to_user_id)
    and not is_blocked_with(to_user_id)
    and state = 'pending'
  );

-- Only the recipient answers, and answering is all they may do: `from_user_id`,
-- `to_user_id` and `payload` are pinned by the with-check so an update cannot
-- rewrite what was sent or who sent it.
create policy shared_routines_respond on shared_routines
  for update to authenticated
  using (to_user_id = auth.uid())
  with check (to_user_id = auth.uid() and state in ('accepted', 'dismissed'));

-- The sender can withdraw one; the recipient can clear their own inbox.
create policy shared_routines_delete on shared_routines
  for delete to authenticated
  using (auth.uid() in (from_user_id, to_user_id));
