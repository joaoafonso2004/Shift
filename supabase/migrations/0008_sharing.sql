-- Shift 0008 — sending a routine to a friend.
--
-- The payload is stored as jsonb rather than as rows in `routine_exercises`,
-- and that is deliberate. A sent routine is a *message*, not a record: it has to
-- survive the sender editing their own routine afterwards, or deleting it
-- outright, without the thing you received changing under you. Normalising it
-- would make every share a live view of somebody else's mutable data.
--
-- Read `supabase/tests/rls.sql` alongside this file. Every claim made in a
-- comment here is asserted there against a real Postgres, because the first
-- draft of this migration made three claims that were not true and the parser
-- was perfectly happy with all of them.

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
    check (message is null or length(message) <= 280),

  -- Enough shape that a payload reaching an inbox is recognisably a routine.
  --
  -- This does **not** try to validate the whole schema — `parseSharedRoutine`
  -- does that on the client, field by field, and is where a hostile payload is
  -- actually made harmless. What this stops is the cheap nonsense: `'42'::jsonb`
  -- posted straight to PostgREST, an empty exercise list, a version this build
  -- cannot read. A v2 format will need this constraint widened, deliberately.
  constraint shared_routines_payload_shape
    check (
      jsonb_typeof(payload) = 'object'
      and payload->>'version' = '1'
      and jsonb_typeof(payload->'exercises') = 'array'
      and jsonb_array_length(payload->'exercises') between 1 and 24
    )
);

-- The inbox query: everything pending, for me, newest first.
create index shared_routines_inbox_idx
  on shared_routines (to_user_id, state, created_at desc);

create index shared_routines_sent_idx
  on shared_routines (from_user_id, created_at desc);

-- Stops a tap that fires twice, and the nuisance of one routine pushed at
-- someone repeatedly while they have not answered.
--
-- It is a fingerprint of the payload text, not of the routine's meaning: a
-- sender who adds a junk field gets a different hash and a second row. That is
-- a deliberate limit, not an oversight — deduplicating by meaning would need a
-- canonical form of the payload, and the answer to somebody determined to spam
-- you is the block button, which exists.
create unique index shared_routines_pending_unique_idx
  on shared_routines (from_user_id, to_user_id, md5(payload::text))
  where state = 'pending';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- These are load-bearing, and are the half of the protection that policies
-- cannot provide.
--
-- A `WITH CHECK` clause is evaluated against the *proposed new row*. It has no
-- access to the old one, so it cannot express "this column may not change" —
-- an unmentioned column is simply unconstrained. The first draft of this file
-- claimed the with-check pinned `from_user_id` and `payload`; it did not, and a
-- recipient could rewrite an incoming share to look as though any user had sent
-- them anything.
--
-- Column-level grants are the mechanism that actually makes a column
-- immutable. Supabase grants ALL on public tables to `anon` and `authenticated`
-- by default, so this starts by taking that back.
-- ---------------------------------------------------------------------------

revoke all on shared_routines from anon, authenticated;

grant select on shared_routines to authenticated;

-- `id`, `state`, `created_at` and `responded_at` are the server's to set. A
-- client that could write `created_at` could post a share dated in the future
-- and pin itself to the top of someone's inbox forever.
grant insert (from_user_id, to_user_id, payload, message) on shared_routines to authenticated;

-- Answering is all a recipient may do.
grant update (state, responded_at) on shared_routines to authenticated;

grant delete on shared_routines to authenticated;

-- `revoke all` above also removes TRUNCATE, which `grant all` includes and
-- which **row level security does not apply to**. PostgREST does not expose it,
-- so this is not remotely reachable — but every other table in this schema is
-- still in that position, and that is worth knowing rather than assuming.

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
  );

-- One answer per share, given only by its recipient.
--
-- `state = 'pending'` in the using clause is what makes answering one-way.
-- Without it a recipient can flip a share between accepted and dismissed
-- indefinitely, and every flip is a write the sender can see.
create policy shared_routines_respond on shared_routines
  for update to authenticated
  using (to_user_id = auth.uid() and state = 'pending')
  with check (to_user_id = auth.uid() and state in ('accepted', 'dismissed'));

-- A recipient may clear anything from their own inbox. A sender may only
-- withdraw something still unanswered — taking back a routine somebody already
-- accepted would delete their evidence of where it came from.
create policy shared_routines_delete on shared_routines
  for delete to authenticated
  using (
    to_user_id = auth.uid()
    or (from_user_id = auth.uid() and state = 'pending')
  );
