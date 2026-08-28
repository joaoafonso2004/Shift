-- Row level security, actually exercised.
--
-- `npm run check:migrations` proves the 119 statements parse. It cannot prove
-- that a policy does what its comment says, and a policy that is merely *wrong*
-- parses perfectly — it just quietly lets the wrong person read the wrong row.
-- Every claim in `supabase/README.md` about who can see or send what is
-- asserted here, against the real stack, with real roles.
--
-- Run with `npm run db:test`. The whole file is one transaction and ends in a
-- rollback, so it can be run repeatedly against a database with data in it.

\o /dev/null

begin;

create schema shift_test;
grant usage on schema shift_test to authenticated;

/**
 * Become a user, the way a request from the app does.
 *
 * `request.jwt.claims` is what `auth.uid()` reads, so setting it is exactly
 * equivalent to arriving with that user's token — no auth server involved and
 * no way for the test to accidentally be more privileged than the app.
 */
create function shift_test.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create function shift_test.as_postgres() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

/** Assert a statement is refused, and say which rule was expected to refuse it. */
create function shift_test.refused(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL: % — the statement was ALLOWED', p_label;
exception
  when insufficient_privilege or check_violation or unique_violation
    or foreign_key_violation or not_null_violation then
    raise notice 'ok    %', p_label;
end $$;

/**
 * Assert a statement changes nothing.
 *
 * The distinction this exists for: a `USING` clause **filters**, a `WITH CHECK`
 * clause **raises**. A row excluded by USING is simply not visible to the
 * statement, so an UPDATE or DELETE that "violates" it reports success and
 * affects zero rows. Asserting an error there would be asserting the wrong
 * thing — and any client that reads only the error is being told it succeeded.
 */
create function shift_test.affects_nothing(p_sql text, p_label text) returns void
language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL: % — % row(s) were changed', p_label, n;
  end if;
  raise notice 'ok    %', p_label;
end $$;

create function shift_test.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % — expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok    %', p_label;
end $$;

grant execute on all functions in schema shift_test to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: four people. ana and bo are friends, cy is a stranger, dee is blocked.
-- ---------------------------------------------------------------------------

create table shift_test.ids (who text primary key, id uuid not null);
grant select on shift_test.ids to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ana@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'bo@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'cy@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'dee@example.test');

insert into shift_test.ids values
  ('ana', '11111111-1111-4111-8111-111111111111'),
  ('bo',  '22222222-2222-4222-8222-222222222222'),
  ('cy',  '33333333-3333-4333-8333-333333333333'),
  ('dee', '44444444-4444-4444-8444-444444444444');

insert into profiles (id, display_name, handle) values
  ('11111111-1111-4111-8111-111111111111', 'Ana', 'ana'),
  ('22222222-2222-4222-8222-222222222222', 'Bo',  'bo'),
  ('33333333-3333-4333-8333-333333333333', 'Cy',  'cy'),
  ('44444444-4444-4444-8444-444444444444', 'Dee', 'dee');

-- ana + bo accepted. user_a is always the smaller id, per friendships_ordered.
insert into friendships (user_a, user_b, state, actor_id) values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   'accepted', '11111111-1111-4111-8111-111111111111');

-- ana blocked dee.
insert into friendships (user_a, user_b, state, actor_id) values
  ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444',
   'blocked', '11111111-1111-4111-8111-111111111111');

\set ana '11111111-1111-4111-8111-111111111111'
\set bo  '22222222-2222-4222-8222-222222222222'
\set cy  '33333333-3333-4333-8333-333333333333'
\set dee '44444444-4444-4444-8444-444444444444'

\echo ''
\echo '-- friendship helpers ------------------------------------------------'

select shift_test.as_user(:'ana');
select shift_test.eq(are_friends(:'bo'), true, 'are_friends sees an accepted friendship');
select shift_test.eq(are_friends(:'cy'), false, 'a stranger is not a friend');
select shift_test.eq(is_blocked_with(:'dee'), true, 'a block is visible to the blocker');

select shift_test.as_user(:'bo');
-- The row is stored one way round; the helper has to answer both.
select shift_test.eq(are_friends(:'ana'), true, 'are_friends works from the other side of the row');

select shift_test.as_user(:'dee');
select shift_test.eq(is_blocked_with(:'ana'), true, 'a block is visible to the blocked party too');

\echo ''
\echo '-- profile visibility ------------------------------------------------'

select shift_test.as_user(:'cy');
select shift_test.eq(
  (select count(*)::int from profiles where id = :'ana'), 1,
  'a discoverable stranger is findable');

select shift_test.as_postgres();
update profiles set privacy = jsonb_set(privacy, '{discoverable}', 'false') where id = :'ana';

select shift_test.as_user(:'cy');
select shift_test.eq(
  (select count(*)::int from profiles where id = :'ana'), 0,
  'turning off discoverable removes you from search entirely');

select shift_test.as_user(:'bo');
select shift_test.eq(
  (select count(*)::int from profiles where id = :'ana'), 1,
  'a friend still sees you when you are not discoverable');

select shift_test.as_user(:'dee');
select shift_test.eq(
  (select count(*)::int from profiles where id = :'ana'), 0,
  'a block hides the profile even from a would-be searcher');

select shift_test.as_postgres();
update profiles set privacy = jsonb_set(privacy, '{discoverable}', 'true') where id = :'ana';

\echo ''
\echo '-- sharing a routine (0008) ------------------------------------------'

select shift_test.as_user(:'ana');

-- The happy path. Everything below is a variation on why it should not work.
insert into shared_routines (from_user_id, to_user_id, payload, message)
values (:'ana', :'bo', '{"version":1,"title":"Leg day","exercises":[{"exerciseId":"0043","sets":3,"reps":5}]}'::jsonb, 'try this');
select shift_test.eq(
  (select count(*)::int from shared_routines where to_user_id = :'bo'), 1,
  'a friend can send a routine');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb)', :'ana', :'cy'),
  'a stranger cannot be sent a routine');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb)', :'ana', :'dee'),
  'a blocked user cannot be sent a routine');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb)', :'cy', :'bo'),
  'you cannot send a routine as somebody else');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb)', :'ana', :'ana'),
  'you cannot send a routine to yourself');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload, state) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb, ''accepted'')', :'ana', :'bo'),
  'you cannot send something pre-accepted on the recipient''s behalf');

-- The partial unique index: the same routine cannot sit unanswered twice.
select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"title":"Leg day","exercises":[{"exerciseId":"0043","sets":3,"reps":5}]}''::jsonb)', :'ana', :'bo'),
  'the same routine cannot be sent twice while it is still pending');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, %L::jsonb)', :'ana', :'bo',
         '{"version":1,"exercises":[{"exerciseId":"0043"}],"pad":"' || repeat('x', 9000) || '"}'),
  'an oversized payload is refused by the database, not just the client');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''42''::jsonb)', :'ana', :'bo'),
  'a payload that is not even an object is refused');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":1,"exercises":[]}''::jsonb)', :'ana', :'bo'),
  'a routine with no exercises is refused');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload) values (%L, %L, ''{"version":2,"exercises":[{"exerciseId":"0043"}]}''::jsonb)', :'ana', :'bo'),
  'a payload from a format this build cannot read is refused');

-- A future date would pin the row to the top of the recipient's inbox, which is
-- ordered by created_at desc.
select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload, created_at) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb, ''9999-12-31'')', :'ana', :'bo'),
  'a sender cannot choose when their share claims to have been sent');

select shift_test.refused(
  format('insert into shared_routines (from_user_id, to_user_id, payload, responded_at) values (%L, %L, ''{"version":1,"exercises":[{"exerciseId":"0043"}]}''::jsonb, now())', :'ana', :'bo'),
  'a sender cannot claim their share was already answered');

\echo ''
\echo '-- who can see and answer a share ------------------------------------'

select shift_test.as_user(:'cy');
select shift_test.eq(
  (select count(*)::int from shared_routines), 0,
  'a third party cannot see a share between two other people');

select shift_test.as_user(:'ana');
select shift_test.eq(
  (select count(*)::int from shared_routines), 1,
  'the sender can see what they sent');

select shift_test.as_user(:'bo');
select shift_test.eq(
  (select count(*)::int from shared_routines), 1,
  'the recipient can see it');

-- Only the recipient answers.
update shared_routines set state = 'accepted', responded_at = now() where to_user_id = :'bo';
select shift_test.eq(
  (select state from shared_routines limit 1), 'accepted',
  'the recipient can accept');

select shift_test.as_user(:'ana');
select shift_test.eq(
  (select count(*)::int from shared_routines where state = 'dismissed'), 0,
  'the sender cannot answer on the recipient''s behalf');

\echo ''
\echo '-- the payload cannot be rewritten after the fact ---------------------'

select shift_test.as_user(:'bo');

-- The finding this whole file exists for. WITH CHECK evaluates the *new* row
-- and cannot see the old one, so it can never make a column immutable — only a
-- column-level grant does that.
select shift_test.refused(
  format('update shared_routines set from_user_id = %L where to_user_id = %L', :'cy', :'bo'),
  'answering a share cannot rewrite who sent it');

select shift_test.refused(
  format('update shared_routines set payload = ''{"version":1,"exercises":[{"exerciseId":"9999"}]}''::jsonb where to_user_id = %L', :'bo'),
  'answering a share cannot rewrite what was sent');

select shift_test.refused(
  format('update shared_routines set message = ''forged'' where to_user_id = %L', :'bo'),
  'answering a share cannot rewrite the message that came with it');

select shift_test.refused(
  format('update shared_routines set created_at = ''9999-12-31'' where to_user_id = %L', :'bo'),
  'answering a share cannot backdate or postdate it');

-- Already accepted further up the file, so the using clause now excludes it.
select shift_test.affects_nothing(
  format('update shared_routines set state = ''dismissed'' where to_user_id = %L', :'bo'),
  'a share can only be answered once');

\echo ''
\echo '-- withdrawing --------------------------------------------------------'

select shift_test.as_user(:'ana');
select shift_test.affects_nothing(
  format('delete from shared_routines where from_user_id = %L', :'ana'),
  'a sender cannot withdraw a routine the recipient already accepted');

select shift_test.as_user(:'bo');
delete from shared_routines where to_user_id = :'bo';
select shift_test.eq(
  (select count(*)::int from shared_routines), 0,
  'a recipient can clear their own inbox');

\echo ''
\echo '-- avatars ------------------------------------------------------------'

select shift_test.as_postgres();
insert into storage.objects (bucket_id, name, owner)
values ('avatars', :'ana' || '/avatar.jpg', :'ana');

select shift_test.as_user(:'bo');
select shift_test.eq(
  (select count(*)::int from storage.objects where bucket_id = 'avatars'), 1,
  'a friend can load your avatar');

select shift_test.as_user(:'cy');
select shift_test.eq(
  (select count(*)::int from storage.objects where bucket_id = 'avatars'), 1,
  'a discoverable stranger can load your avatar, because a faceless search result is useless');

select shift_test.as_user(:'dee');
select shift_test.eq(
  (select count(*)::int from storage.objects where bucket_id = 'avatars'), 0,
  'a block hides the avatar');

select shift_test.as_user(:'cy');
select shift_test.refused(
  format('insert into storage.objects (bucket_id, name, owner) values (''avatars'', %L, %L)', :'ana' || '/avatar.jpg', :'cy'),
  'nobody can write an avatar into someone else''s folder');

\echo ''
\echo '======================================================================'
\echo ' every assertion passed'
\echo '======================================================================'

rollback;
