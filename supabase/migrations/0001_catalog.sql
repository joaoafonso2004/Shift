-- Shift 0001 — exercise catalog.
--
-- Mirrors the bundled SQLite asset. The app reads the catalog locally and never
-- queries this at runtime; the Postgres copy exists so the similarity matrix and
-- the biomechanical enrichment can be corrected without shipping an app update.
--
-- Column names match what scripts/catalog/emit.ts writes into
-- data/seed/catalog.sql. Changing one without the other breaks the seed.

create extension if not exists pgcrypto;

create table exercises (
  id                text primary key,
  name              text not null,
  body_part         text not null,
  raw_target        text not null,
  raw_equipment     text not null,
  target_canon      text not null,
  secondary_canon   text[] not null default '{}',
  variant_key       text not null,
  movement_pattern  text not null,
  family            text not null,
  plane             text not null,
  load_type         text not null,
  is_compound       boolean not null,
  is_unilateral     boolean not null,
  stability_demand  smallint not null,
  skill_level       smallint not null,
  classification    text not null,
  image             text,
  gif_url           text,
  media_url         text,
  instructions      text,
  attribution       text not null,
  enrichment_ver    smallint not null default 1,
  created_at        timestamptz not null default now()
);

create index exercises_target_pattern_idx on exercises (target_canon, movement_pattern);
create index exercises_body_part_idx      on exercises (body_part);
create index exercises_load_type_idx      on exercises (load_type);
-- Media variants of one movement share a key; the app groups by it when browsing.
create index exercises_variant_idx        on exercises (variant_key);

-- Precomputed top-K neighbours. `rank` is the selection order produced by the
-- build-time diversity pass, NOT descending score: rank 3 can legitimately score
-- below rank 4. Always read with `order by rank`.
create table exercise_similarity (
  exercise_id text not null references exercises(id) on delete cascade,
  alt_id      text not null references exercises(id) on delete cascade,
  score       real not null,
  rank        smallint not null,
  reason      jsonb not null,
  primary key (exercise_id, rank)
);

create index exercise_similarity_lookup_idx on exercise_similarity (exercise_id, rank);

-- The catalog is public reference data: readable by any authenticated user,
-- writable only by the service role running the build.
alter table exercises enable row level security;
alter table exercise_similarity enable row level security;

create policy exercises_read on exercises
  for select to authenticated using (true);
create policy exercise_similarity_read on exercise_similarity
  for select to authenticated using (true);
