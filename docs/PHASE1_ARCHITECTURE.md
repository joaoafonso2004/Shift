# Shift — Phase 1 Architecture Plan

> Motion is the product. This document is the contract that keeps it that way.

---

## 0. Version reality check (read first)

The brief specifies **Expo SDK 51+ / Reanimated 3**. Both are shippable, but as of now:

| Brief | Installed | Notes |
|---|---|---|
| Expo SDK 51 (RN 0.74, Old Arch) | **SDK 57.0.9 / RN 0.86.2**, New Architecture default | Six SDKs newer than the brief |
| Reanimated 3 | **Reanimated 4.5.1** + `react-native-worklets` 0.10.1 | Fabric-only; worklets split into their own package |
| — | React 19.2.3, Gesture Handler 2.32, NativeWind 4.2.6, TypeScript 6.0 | |

Why this matters for *this* app specifically:

- Reanimated 4 requires the New Architecture, and Fabric is what removes the last JS-thread involvement in layout commits. On the Old Architecture, `LinearTransition` and shared-element morphs still round-trip through the shadow tree in ways that show up as hitches during drag-reorder.
- Reanimated 4's imperative API is source-compatible with v3 (`useSharedValue`, `useAnimatedStyle`, `withSpring`, `useFrameCallback`). Nothing in this plan is thrown away by choosing v4 — `runOnJS`/`runOnUI` simply move to `react-native-worklets` (v4 keeps aliases).
- v4 adds CSS-style animations/transitions, which are a trap for us: convenient, but harder to interrupt mid-flight and to seed with gesture velocity. **We use the imperative worklet API throughout.** CSS animations are allowed only for decorative, non-interruptible loops (skeleton shimmer, pulse).

**Hard constraint:** the haptics strategy (§5) and 120 Hz unlock require native config. This app runs on **Expo Dev Client + EAS Build (Continuous Native Generation)** — still "managed workflow", but **it will not run in Expo Go**. Plan for this on day one.

**Two v3→v4 renames already bit during the scaffold**, both caught by the typechecker rather than at runtime:

- `_getAnimationTimestamp()` is no longer exported. `useTimestamp` exists but is a hook, so it cannot be called inside a worklet callback. The haptic rate limiter uses `Date.now()` instead — available on the UI runtime, and millisecond resolution is ample for a 400 ms gate.
- `Animated.SharedValue` as a namespace type is gone; import the named `SharedValue` type.

Two toolchain conflicts also surfaced and are worth knowing about before they cost someone an afternoon:

- `"type": "module"` in `package.json` — required for the Node-native TypeScript test runner — makes Babel and Metro read their `.js` configs as ESM and fail. The configs are therefore `babel.config.cjs`, `metro.config.cjs`, and `tailwind.config.cjs`.
- TypeScript 6 (which SDK 57 requires) rejects the `import '../global.css'` side-effect import without an ambient declaration, and needs `types: ["node"]` set explicitly so the build scripts and the app can typecheck in one pass.

---

## 1. Application architecture

### 1.1 The central principle: two runtimes, one boundary

Every architectural decision below follows from one rule:

> **Motion state lives on the UI runtime. Facts live on the JS runtime. The boundary is crossed once per interaction — never once per frame.**

```
┌─────────────────────────────── UI RUNTIME (120 Hz, 8.33 ms budget) ──┐
│  Gesture Handler callbacks (worklets, native thread)                 │
│  Shared values ── useDerivedValue ── useAnimatedReaction             │
│  useAnimatedStyle / useAnimatedProps  →  Fabric commit               │
│  useFrameCallback (rest timer, scrub throttling)                     │
│  measure() for morph geometry                                        │
│  Synchronous haptic JSI binding                                      │
└───────────────────────▲──────────────────────────┬───────────────────┘
      runOnUI (setup,   │                          │  runOnJS (commit,
      realtime ingress) │                          │  once per gesture)
┌───────────────────────┴──────────────────────────▼───────────────────┐
│                     JS RUNTIME (Hermes)                              │
│  Zustand stores (workout session, user prefs)  + MMKV persistence    │
│  TanStack Query (server cache, optimistic mutations)                 │
│  Supabase client: Realtime (broadcast/presence), Postgres, Storage   │
│  expo-sqlite: bundled exercise catalog + similarity matrix           │
│  Outbox: durable offline mutation queue                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 Layers

**L0 — Native config layer**
`expo-build-properties` + custom config plugins. Owns: `CADisableMinimumFrameDurationOnPhone`, New Arch flags, Core Haptics entitlements, the local haptics module.

**L1 — Motion primitives** (`src/motion/`)
Framework-agnostic, no business logic, no network. `usePressScale`, `useScrubNumber`, `useSortable`, `useCardRing`, `useSyncedCountdown`, `useHapticEngine`, `springs.ts` (the single motion token file). **Every animation in the app pulls its physics from `springs.ts`.** No inline spring configs anywhere — that's how apps end up feeling inconsistent.

**L2 — UI components** (`src/components/`)
Presentational. NativeWind for *static* style only. Any property that changes at frame rate comes from `useAnimatedStyle`.

**L3 — Feature screens** (`src/features/`)
`workout/`, `catalog/`, `coop/`, `history/`. Own the wiring between L2 and L4.

**L4 — Domain** (`src/domain/`)
Pure TS, zero React. Progression prediction, e1RM math, similarity re-ranking, set-state machine. Unit-testable in Node, which matters because this is the logic that must never be debugged through an animation.

**L5 — Data** (`src/data/`)
`catalog.ts` (SQLite reads), `supabase.ts`, `realtime/` (channel managers), `outbox.ts`.

### 1.3 State ownership map

This table is the thing to argue about now, not later.

| State | Owner | Rationale |
|---|---|---|
| Card swipe X, scale, rotation | Shared value | Frame rate |
| Drag-reorder row offsets | Shared value (`positions` object SV) | Frame rate |
| Scrub-in-progress weight value | Shared value | Frame rate |
| **Committed** weight/reps for a set | Zustand → SQLite outbox → Supabase | Fact |
| Rest remaining, self **and squad** | Shared values + one `useFrameCallback` | Frame rate; **never** JS `setInterval` |
| Rest *end timestamps* (per member) | Zustand (from Realtime), mirrored to SVs | Fact |
| Squad progress / state (×3) | Realtime → `runOnUI` → shared values | Animated, never re-renders the tree |
| Squad member **count** | Zustand → mirrored to SV | Fact, but drives pod-width springs |
| Turn cursor / active lifter | Zustand (authoritative from RPC) | Fact; CAS-guarded (§2.4) |
| Rotation + plate plan | Zustand, versioned by `plan_version` | Fact; computed server-side |
| Which exercise is active | Zustand | Fact; changes ~20×/session |
| Swap candidate ring contents | `useRef` + Zustand (computed at mount) | Must be stable during gesture |

**Non-negotiable:** nothing in the "shared value" rows is ever mirrored into React state while a gesture is active.

### 1.4 Navigation

Expo Router (file-based). Two caveats for a motion-first app:

- Use **native stack** (`react-native-screens`) so push/pop transitions are UIKit-driven, not JS-driven.
- For the workout player, avoid navigation entirely between exercises. The player is **one screen** with a recycled card ring (§4.2). Navigating per-exercise would mean mount cost inside a gesture — the exact thing we're designing against.
- Modal sheets (rest timer, set editor) via a Reanimated-driven custom sheet, not a JS-animated library, so the sheet can hand velocity to the underlying scroll.

### 1.5 Persistence & offline

Gyms have bad signal. The app must be fully functional with zero connectivity, including a *degraded* co-op mode.

- **Exercise catalog**: read-only SQLite shipped as an app asset. Never fetched at runtime.
- **User data**: writes go to a local SQLite `outbox` table first (monotonic `client_seq`), then flush to Supabase. UI reads local state — it never waits on the network to render a completed set.
- **Conflict policy**: sets are append-only and owned by exactly one user, so last-write-wins on `(workout_exercise_id, set_index)` is sufficient. No CRDT needed.

---

## 2. Supabase schema

### 2.1 Catalog (read-mostly, mirrored into the app bundle)

```sql
create table exercises (
  id                text primary key,               -- '0001' … dataset id
  name              text not null,
  body_part         text not null,                  -- dataset enum (10 values)
  target            text not null,                  -- raw dataset string
  equipment         text not null,                  -- raw dataset string
  muscle_group      text not null,
  secondary_muscles text[] not null default '{}',
  image             text,
  gif_url           text,
  media_url         text,                           -- our transcoded WebP/HEVC
  attribution       text not null,
  -- derived biomechanical enrichment (see §5)
  target_canon      text not null,                  -- normalized muscle key
  secondary_canon   text[] not null default '{}',
  movement_pattern  text not null,                  -- horizontal_push | hinge | …
  plane             text not null,                  -- sagittal | frontal | transverse
  load_type         text not null,                  -- barbell | dumbbell | cable | …
  is_compound       boolean not null,
  is_unilateral     boolean not null,
  stability_demand  smallint not null,              -- 0 machine … 2 free
  skill_level       smallint not null,              -- 0..2
  enrichment_ver    smallint not null default 1,
  created_at        timestamptz not null default now()
);
create index on exercises (target_canon, movement_pattern);
create index on exercises (body_part);

-- Precomputed offline. Top-K neighbours per exercise.
create table exercise_similarity (
  exercise_id  text not null references exercises(id) on delete cascade,
  alt_id       text not null references exercises(id) on delete cascade,
  score        real not null,
  rank         smallint not null,
  reason       jsonb not null,     -- {target:1, pattern:1, plane:0, jaccard:0.66}
  primary key (exercise_id, rank)
);
create index on exercise_similarity (exercise_id, score desc);
```

`exercise_similarity` is generated by a build-time job (§5.4) and shipped in the SQLite asset. The Postgres copy exists so the matrix can be updated without an app release.

### 2.2 User, routines, history

```sql
create table profiles (
  id                 uuid primary key references auth.users on delete cascade,
  display_name       text,
  unit_system        text not null default 'metric',   -- metric | imperial
  default_rest_s     int  not null default 90,
  haptic_intensity   smallint not null default 2,      -- 0 off … 3 intense
  reduce_motion      boolean not null default false,
  available_equipment text[] not null default '{}',    -- re-ranks swaps
  created_at         timestamptz not null default now()
);

create table routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table routine_exercises (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references routines(id) on delete cascade,
  exercise_id text not null references exercises(id),
  order_index smallint not null,
  target_sets smallint not null default 3,
  rest_s int,
  unique (routine_id, order_index) deferrable initially deferred
);

create table workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  routine_id uuid references routines(id) on delete set null,
  sync_session_id uuid references sync_sessions(id) on delete set null,
  status text not null default 'active',        -- active | completed | abandoned
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  total_volume_kg numeric(10,2),
  client_id text not null,                       -- offline idempotency key
  unique (user_id, client_id)
);
create index on workouts (user_id, started_at desc);

create table workout_exercises (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references workouts(id) on delete cascade,
  exercise_id text not null references exercises(id),
  swapped_from_exercise_id text references exercises(id),   -- swap analytics
  order_index smallint not null,
  created_at timestamptz not null default now()
);
create index on workout_exercises (workout_id, order_index);

-- The hot table. Every logged set, forever.
create table sets (
  id uuid primary key default gen_random_uuid(),
  workout_exercise_id uuid not null references workout_exercises(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,  -- denormalized for RLS + index
  exercise_id text not null references exercises(id),               -- denormalized for progression queries
  set_index smallint not null,
  weight_kg numeric(6,2),
  reps smallint,
  rpe numeric(3,1),
  is_warmup boolean not null default false,
  e1rm numeric(6,2) generated always as (
    case when weight_kg is not null and reps is not null and reps between 1 and 12
         then weight_kg * (1 + reps / 30.0) else null end
  ) stored,                                                          -- Epley
  completed_at timestamptz not null default now(),
  client_seq bigint not null,
  unique (workout_exercise_id, set_index)
);
create index on sets (user_id, exercise_id, completed_at desc);
```

**Prediction feed — the "lazy logging" engine.** A trigger-maintained table, not a query, because the predictor must return in <1 ms during card mount:

```sql
create table exercise_progression (
  user_id uuid not null references profiles(id) on delete cascade,
  exercise_id text not null references exercises(id),
  last_session_at timestamptz not null,
  last_sets jsonb not null,         -- [{set_index, weight_kg, reps, rpe}, …]
  best_e1rm numeric(6,2),
  best_e1rm_at timestamptz,
  session_count int not null default 0,
  trend_kg_per_session numeric(5,2),   -- Theil-Sen slope over session-best e1RM (§7.3)
  consecutive_failures smallint not null default 0,
  primary key (user_id, exercise_id)
);
```

`consecutive_failures` is stored rather than recomputed because it is **not derivable from `last_sets`**. Choosing between "retry the same weight" and "deload" requires memory further back than one session, and having the client walk history to find out would put a multi-session query on the card-mount path — the one place §4.4 cannot afford it.

Maintained by an `after insert on sets` trigger. PRs are detected in the same trigger and pushed to the client via Realtime so the PR celebration animation fires the instant the set is committed.

### 2.3 Local co-op — squads of 2–4

Three things break when you generalize a pair to a squad of four, and the schema has to answer all three:

- **Rest is no longer one shared number.** With N people rotating a station, your rest is `(N−1) × (work + transition)`. It's a *derived* consequence of the rotation, not an input. A session-level `rest_ends_at` is wrong at N > 2.
- **Turn state gets contended.** Two clients racing on "I'm done" is tolerable; four is not. Turn advancement needs compare-and-swap, not last-write-wins.
- **Squads of four rarely share one bar.** They split — two on bench, two on rows. **Stations** are the correct unit of rotation, not the session.

```sql
create table sync_sessions (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references profiles(id) on delete cascade,  -- a label, not authority
  join_code text not null unique,            -- 6 chars, also encoded as QR
  status text not null default 'open',       -- open | active | ended
  max_members smallint not null default 4 check (max_members between 2 and 4),
  -- gym context: drives all plate math for every station
  bar_weight_kg  numeric(5,2) not null default 20,
  plate_inventory jsonb not null default
    '{"25":4,"20":4,"15":2,"10":4,"5":4,"2.5":4,"1.25":2}',   -- plates PER SIDE
  min_increment_kg numeric(4,2) not null default 1.25,
  pacing_mode text not null default 'auto',  -- auto | flow | even  (see §6.2)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours'
);

-- The unit of rotation. A session has 1..N stations; a squad of 4 may split 2+2.
create table sync_stations (
  id uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sync_sessions(id) on delete cascade,
  exercise_id text not null references exercises(id),
  order_index smallint not null,
  -- authoritative turn state, mutated ONLY via advance_turn() (§2.4)
  turn_cursor    bigint not null default 0,     -- monotonic CAS token
  active_user_id uuid references profiles(id),
  turn_started_at  timestamptz,
  turn_deadline_at timestamptz,                 -- soft cap → auto-advance past a stalled member
  round_index    smallint not null default 0,
  direction      smallint not null default 1,   -- +1 ascending load, −1 descending (serpentine)
  loaded_kg      numeric(6,2),                  -- what is physically on the bar right now
  plan_version   int not null default 0,
  unique (session_id, order_index)
);

create table sync_members (
  session_id uuid not null references sync_sessions(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  workout_id uuid references workouts(id) on delete set null,
  station_id uuid references sync_stations(id) on delete set null,
  role text not null default 'member',          -- host | member
  color_slot smallint not null check (color_slot between 0 and 3),  -- stable identity hue
  queue_pos  smallint not null,                 -- position within the station rotation
  state text not null default 'idle',           -- idle|working|resting|ready|stalled|away
  current_set_index smallint not null default 0,
  target_sets smallint,
  -- the asymmetric bits: every member has their own load, from their own history
  planned_load_kg    numeric(6,2),
  planned_reps       smallint,
  relative_intensity numeric(4,3),              -- planned_load / their best_e1rm  → the DISPLAY metric
  avg_work_s         smallint not null default 40,   -- rolling estimate, feeds cadence math
  rest_target_s      int not null default 90,
  rest_ends_at       timestamptz,               -- PER-MEMBER. There is no session-level timer.
  last_seen_at timestamptz not null default now(),
  primary key (session_id, user_id),
  unique (session_id, color_slot)
);
create index on sync_members (station_id, queue_pos);

-- Materialized rotation plan: who lifts when, at what load, and what plates move between turns.
-- Computed server-side so all N clients agree on one plan rather than each deriving its own.
create table station_turn_plan (
  station_id  uuid not null references sync_stations(id) on delete cascade,
  round_index smallint not null,
  slot        smallint not null,
  user_id     uuid not null references profiles(id),
  load_kg     numeric(6,2) not null,
  plate_delta jsonb not null,      -- {"add":[10,2.5],"remove":[20]}  per side
  transition_s smallint not null,  -- estimated changeover cost, feeds cadence prediction
  primary key (station_id, round_index, slot)
);

-- Append-only, ordered, replayable. Survives reconnects and host handover.
create table sync_events (
  seq bigint generated always as identity primary key,
  session_id uuid not null references sync_sessions(id) on delete cascade,
  station_id uuid references sync_stations(id) on delete cascade,
  actor_user_id uuid not null references profiles(id),
  type text not null,   -- set_completed | turn_advanced | round_completed | rest_skipped
                        -- load_changed | replanned | exercise_swapped | joined | left | stalled
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on sync_events (session_id, seq);
```

`workouts.sync_session_id` still points at the session, so each member's history remains their own — a squad session is a *coordination* layer over four independent workouts, never a shared one. This matters for the progression predictor: four people on one bar have four different `exercise_progression` rows, and none of them is polluted by the others.

### 2.4 RLS and serialized turn advancement

A self-referential policy on `sync_members` recurses. Route membership checks through a `security definer` helper — mandatory once the membership table is also the table being protected:

```sql
create function is_session_member(p_session uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from sync_members
                 where session_id = p_session and user_id = auth.uid());
$$;

alter table sets enable row level security;
create policy sets_own on sets using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table sync_members enable row level security;
create policy sm_read  on sync_members for select using (is_session_member(session_id));
create policy sm_write on sync_members for update using (user_id = auth.uid());

alter table sync_stations enable row level security;
create policy st_read on sync_stations for select using (is_session_member(session_id));
-- no direct UPDATE policy: turn state moves only through advance_turn()
```

Squadmates see each other's **progress**, never each other's raw `sets` rows. Co-op reads go through `sync_members`, `sync_stations`, and `sync_events`, which keeps the policy on the hot table a bare `user_id = auth.uid()`. Simple RLS on `sets` is a performance decision as much as a security one, and it's what stops squad size from touching the write path at all.

**Turn advancement is a compare-and-swap RPC, not an UPDATE.** With two people, racing writes to turn state are survivable; with four, "I'm done" events *will* collide — especially at a round boundary where several members finish inside the same second.

```sql
create function advance_turn(p_station uuid, p_expected_cursor bigint)
returns sync_stations language plpgsql security definer as $$
declare s sync_stations;
begin
  update sync_stations
     set turn_cursor = turn_cursor + 1,
         active_user_id  = next_in_rotation(p_station),   -- honours direction + skips 'away'
         turn_started_at = now(),
         turn_deadline_at = now() + make_interval(secs => turn_budget_s(p_station))
   where id = p_station and turn_cursor = p_expected_cursor
   returning * into s;

  if not found then
    raise exception 'stale_cursor' using errcode = '40001';  -- client refetches, no retry storm
  end if;

  insert into sync_events(session_id, station_id, actor_user_id, type, payload)
  values (s.session_id, s.id, auth.uid(), 'turn_advanced',
          jsonb_build_object('cursor', s.turn_cursor, 'active', s.active_user_id));
  return s;
end $$;
```

The losing client gets `stale_cursor`, refetches, and reconciles — it never retries blindly. `turn_cursor` doubles as the ordering token for Realtime: a client that receives a broadcast with a cursor lower than what it holds discards it, which makes out-of-order delivery a non-issue without any client-side sequencing logic.

Realtime channels are private (`topic = 'sync:<session_id>'`) with an RLS policy on `realtime.messages` gating membership.

### 2.5 Realtime transport strategy

The single most important decision in the co-op feature:

| Data | Transport | Why |
|---|---|---|
| Rest timers (per member) | **Broadcast, one message per turn** carrying timestamps | See below |
| Turn advance / rotation plan | `advance_turn()` RPC → Broadcast from DB trigger | Serialized; cursor is the ordering token |
| Set completion | Broadcast + durable `sync_events` row | Fan-out ~tens of ms; the row is the replay log |
| Membership / liveness | **Presence** | Built-in join/leave + timeout, scales to 4 for free |
| Durable history | Postgres writes only | Never on the hot path |

**Do not use Postgres Changes for anything the user sees move.** WAL → Realtime → per-row RLS evaluation adds latency and scales poorly. Broadcast is the transport; the database is the ledger.

**Fan-out at N=4 is a non-issue; contention is the real one.** Steady state is roughly one meaningful event per member per set — about 4 messages per ~40 s at N=4, well under 1 msg/s. Squad size does not threaten throughput. What it threatens is *write ordering* (solved by the CAS RPC in §2.4) and *JS-thread cost on ingress* (§4.7). Design accordingly: the transport is cheap, the deserialization is not.

Payload discipline is therefore stricter than at N=2: broadcasts carry ids and numbers, never objects, and stay under ~256 bytes. Four clients each parsing a fat payload mid-gesture is the JS-starvation risk of §4.7 multiplied by four.

**Presence throttling.** Heartbeat every 5 s. No presence key changes more than once per second — presence state diffs are broadcast to all members, so a chatty presence payload is the one thing that *does* scale badly with N. Progress goes over Broadcast; Presence carries only `{user_id, color_slot, joined_at, last_seen_at}`.

**Liveness degradation, three stages.** Someone always drops in a gym.
- `> 15 s` without heartbeat → `away`. The member's pod dims; they stay in the queue.
- `> 30 s`, or `turn_deadline_at` passes while they hold the turn → `stalled`. `next_in_rotation()` skips them and the rotation continues. **The squad is never blocked on one phone.**
- On reconnect: replay `sync_events` from the last seen `seq`, reconcile against `turn_cursor`, rejoin the queue at the next round boundary rather than mid-round.

**Host failover is a non-event by construction.** `host_user_id` is a display label; all authority lives in Postgres functions. If the host drops, the presence member with the earliest `joined_at` inherits the label. No state transfer, because no client ever held state.

**Timer synchronization — never broadcast ticks, and never a session-level timer.**

At N=2 a single shared countdown is coherent. At N=3–4 it is not: each member's rest is a different interval, ending at a different time. So the authoritative facts broadcast per turn are:

- `sync_members.rest_ends_at` — **per member**, server `now() + rest_target_s`, written when *that* member finishes their set;
- `sync_stations.turn_started_at` / `turn_deadline_at` — the station's cadence.

Each device then:

1. Measures clock offset on join: 3× RPC to `select now()`, take the sample with the lowest RTT, `offset = serverNow − (clientNow + rtt/2)`.
2. Stores `offset` in a shared value.
3. Runs **every** countdown it displays — its own and each squadmate's — in a single `useFrameCallback` worklet against `Date.now() + offset`.

One frame callback drives all four rings. Cost is O(1) in squad size, because the timestamps are already local; nothing is polled and nothing further is exchanged.

All devices then agree to within ~20–50 ms **without another packet**, countdowns survive a dropped connection, and any synchronized haptic is scheduled locally against the shared timestamp. A "buzz now" message would be at the mercy of jitter — and with four phones, jitter means four *audibly* staggered buzzes instead of one squad pulse. This is the entire reason the schema stores end timestamps rather than remaining durations.

---

## 3. Component tree

```
<GestureHandlerRootView>            ← must be the true root
 └ <SafeAreaProvider>
   └ <QueryClientProvider>
     └ <SupabaseProvider>           ← auth session, client singleton
       └ <CatalogProvider>          ← opens SQLite, warms the muscle map
         └ <MotionProvider>         ← global SVs: scrollY, keyboard, reduceMotion,
           │                           hapticIntensity, clockOffset
           └ <CoopProvider>         ← channel lifecycle; writes to SVs via runOnUI
             └ <ExpoRouter />
```

### Workout player (the money screen)

```
<WorkoutScreen>
├── <CollapsingHeader/>              driven by scrollY SV; zero re-renders
├── <SquadRail/>                     height ALWAYS reserved; 0–3 pods (§6.4)
│   ├── <SquadPod/> ×(N−1)           you are never in the rail
│   │   ├── <ProgressRing/>          useAnimatedProps on SVG strokeDashoffset
│   │   └── <PodDetail/>             opacity = interpolate(podWidth) — no breakpoints
│   └── <OnDeckBanner/>              "up in ~40s · bar 100 → 80" — the one line that matters
├── <CardRing/>                      3 mounted, recycled ExerciseCards
│   ├── <ExerciseCard variant="prev"/>
│   ├── <ExerciseCard variant="current"/>       ← receives the pan gesture
│   │   ├── <ExerciseMedia/>                    expo-image, recyclingKey, prefetched
│   │   ├── <SetList/>                          LinearTransition on insert/remove
│   │   │   └── <SetRow/> ×n        (memo; receives SVs, never numbers)
│   │   │       ├── <ScrubNumber unit="kg"/>    pan-to-scrub, worklet-only
│   │   │       ├── <ScrubNumber unit="reps"/>
│   │   │       └── <CompleteSetButton/>        tap → haptic → spring → commit
│   │   └── <SwapHint/>                         opacity = f(dragX), derived value
│   └── <ExerciseCard variant="next"/>
├── <RestTimerSheet/>
│   ├── <CountdownRing/>             useAnimatedProps on SVG strokeDashoffset
│   ├── <CountdownDigits/>           AnimatedTextInput + useAnimatedProps
│   └── <SquadTimerGhosts/>          squadmates' rings overlaid; ONE frame callback drives all
├── <SquadSheet/>                    drag-down disclosure: names, loads, plate plan
└── <BottomBar/>
```

### Motion primitives (`src/motion/`)

| Primitive | Contract |
|---|---|
| `springs.ts` | `press`, `release`, `reorder`, `swap`, `sheet`, `celebrate`. Every config uses `{ dampingRatio, duration }` — refresh-rate independent. |
| `usePressScale()` | Returns `{ gesture, style }`. Scale-down on `onBegin` (not `onStart` — fires before the 130 ms tap threshold, so it feels instant), spring-back on `onFinalize`. |
| `useScrubNumber()` | Pan → value with velocity-dependent granularity + detent haptics. |
| `useSortable()` | Manual `positions` SV + per-row spring. Not `LinearTransition` (§4.3). |
| `useCardRing()` | Index-recycling carousel. Guarantees zero mounts during gesture. |
| `useSyncedCountdown()` | One `useFrameCallback` + clock offset drives **all** squad countdowns. O(1) in N. |
| `useSquadLayout()` | Pod widths as derived values from `memberCount`; springs on join/leave, no re-layout. |
| `useHapticEngine()` | Worklet-callable, rate-limited, priority-ranked, self-relevance filtered (§6.5). |

---

## 4. Worklet / gesture / 120 fps strategy

**This is the section that determines whether the app feels expensive or cheap.**

### 4.0 Unlock 120 Hz first

RN caps at 60 fps on iPhone unless you opt in:

```json
// app.json
{ "expo": { "ios": { "infoPlist": { "CADisableMinimumFrameDurationOnPhone": true } } } }
```

Without this, every spring below is tuned against a lie. Set it before writing a single animation. Budget becomes **8.33 ms/frame**, and ProMotion's adaptive refresh means inconsistent frame *pacing* reads as jank even when average FPS looks fine — we measure deltas, not averages (§4.9).

**This key is native config.** It applies at build time, so a JS reload will not pick it up — removing it and reloading leaves the app looking fine while silently running at 60 Hz. That failure is invisible to an FPS counter, which is the entire reason the sentinel infers the *display refresh rate* rather than just counting frames.

`app/proof.tsx` is the harness that proves it. On a physical ProMotion device:

```bash
npm run ios
```

Then open **Frame sentinel** and read the verdict. It reports one of four states, and the distinction between the middle two is the point:

| Verdict | Meaning | Fix |
|---|---|---|
| `pass` | 120 Hz sustained, hitch rate under 1% | — |
| `capped` | Display pinned near 60 Hz | Configuration. Restore the Info.plist key and **rebuild** — do not optimise |
| `dropping` | 120 Hz display, too many frames over budget | Performance. Something is blocking the UI thread |
| `unknown` | Fewer than 120 frames sampled | Wait |

Both `capped` and `dropping` read as "about 60fps" on a naive counter and have opposite fixes; `tests/frameStats.test.ts` pins that they can never be confused. Raise the node count (0 → 60 → 180 → 400 animated views) until the verdict flips, and drag the card while it does — that number is the real per-device ceiling.

### 4.1 The seven rules

1. **No `setState` inside a gesture.** Not in `onBegin`, `onUpdate`, or `onEnd`. State is committed exactly once, on `onFinalize`, via a single `runOnJS` carrying a complete payload.
2. **Shared values are the only animation truth.** Compose with `useDerivedValue`; react with `useAnimatedReaction`. `useEffect` never drives motion.
3. **Pass shared values into children, never numbers.** A number prop that changes is a re-render; a shared value is a stable reference. Every `SetRow` is `React.memo`'d and receives SVs.
4. **Pre-mount everything a gesture can reach.** Mount cost inside a gesture is unrecoverable — it lands in the middle of the interaction where the user is looking.
5. **Springs, not timings, for anything grabbable.** Springs retarget mid-flight; timings snap and restart. Every release is seeded with the gesture's velocity — that continuity *is* the "organic" feeling.
6. **Nothing crosses the boundary per frame.** Not `console.log` (a bridge hop, banned in gesture paths), not `runOnJS`, not analytics.
7. **The JS thread must stay free anyway.** Animations run on the UI thread, but a blocked JS thread stalls the *next* Fabric commit and starves `runOnJS` commits. Realtime payloads stay tiny; JSON parsing of the catalog never happens at runtime.

### 4.2 Capture discipline (the subtle killer)

Worklets **capture their closure by value and clone it into the UI runtime on every render that recreates them.** Capturing a large object — an exercise record with 10 languages of instructions, say — means serializing that object across runtimes 60–120 times a second's worth of renders.

- Capture only shared values, primitives, and stable function refs.
- Configuration that a worklet needs goes into a shared value (`makeMutable`), not a captured constant.
- Mutate SV objects with `.modify()` (in-place on the UI runtime) rather than `sv.value = {...sv.value, x}`, which reallocates and re-clones:

```ts
positions.modify(p => { 'worklet'; p[id] = newIndex; return p; });
```

### 4.3 Drag-to-reorder: manual springs, not layout animations

`LinearTransition` is the wrong tool for drag-reorder. It reacts to layout *after* the commit, which means it fights the gesture and produces a half-frame of disagreement between finger and content.

Instead: rows are absolutely positioned, driven by a single `positions` shared value (`Record<setId, index>`). The dragged row follows the finger 1:1; every other row runs `withSpring(index * ROW_H, springs.reorder)`. Reordering is a `useAnimatedReaction` on the dragged row's Y that swaps indices in `positions` — entirely on the UI thread, no React involvement, and each displaced row springs with its own physics. That's the "make room" feel the brief asks for.

`LinearTransition` / `entering` / `exiting` remain the right tool for **insert and remove** (adding a set, swap completion), where there's no finger to track.

### 4.4 Swipe-to-Swap: zero layout thrash by construction

Layout thrash during the swap is prevented structurally, not optimized away:

1. **On card mount** (JS thread, idle time), query SQLite for the top-K alternatives, re-rank in the domain layer, and take the best two. Sub-millisecond — it's an indexed local read.
2. **Prefetch media** for those candidates via `expo-image`'s prefetch, so no decode happens during the gesture.
3. **Mount a ring of 3 cards** — `prev`, `current`, `next` — all laid out and measured. `next` is the top-ranked alternative.
4. **The gesture only animates `translateX`, `rotateY` (with perspective), `scale`, and `opacity`** across two already-measured views. Because both cards share identical geometry, the "morph" is a crossfade of content under a synchronized 3D transform — no measurement, no reflow, nothing to thrash.
5. **On `onEnd`**, decide commit-vs-snapback from position *and* velocity, spring accordingly, then a single `runOnJS` rotates the ring index and refills the trailing slot off the critical path.
6. **Keys stay stable across the rotation** so React reconciles a reorder, not a remount.

`measure(animatedRef)` is available inside worklets if a true shared-element morph is needed later — geometry without a JS round-trip.

### 4.5 Rest timer: zero JS renders for 90 seconds

A `setInterval` + `setState` timer re-renders the tree ~90 times and jitters with JS load. Instead:

- `useFrameCallback` computes `remaining = restEndsAt - (Date.now() + clockOffset)` on the UI thread.
- The ring is `useAnimatedProps` on an SVG `strokeDashoffset`.
- The digits are `useAnimatedProps` writing the `text` prop of an `Animated.createAnimatedComponent(TextInput)` — the standard trick for driving text from a worklet, since there is no animated `<Text>`.
- Terminal haptic scheduled in the worklet against the same clock (§2.5).

Result: a co-op rest timer that costs **zero** React renders and stays frame-accurate under JS load.

### 4.6 Haptics from the UI thread

`expo-haptics` is a JS-thread API. Calling it from a worklet means `runOnJS`, which queues behind whatever the JS thread is doing — typically 1–3 frames of latency. For "tactile synchronization," a haptic that lands 25 ms after the visual is perceptibly wrong.

**Phased plan:**

- **Phase 1:** `runOnJS(impact)(style)` — ship it, but instrument the latency.
- **Phase 2 (target):** a local Expo Module (`npx create-expo-module --local`) or Nitro Module exposing a **synchronous JSI function installed on the UI runtime**, callable directly from a worklet. Haptic and visual then originate in the same frame.
- **Phase 3:** Core Haptics `CHHapticAdvancedPatternPlayer` for *continuous* feedback during number scrubbing — a sustained pattern whose intensity/sharpness track scrub velocity, instead of machine-gunning discrete taps. This is what separates a premium feel from a buzzy one.

**Rate limiting is mandatory and lives in the worklet:**

```ts
function haptic(kind: HapticKind) {
  'worklet';
  const now = _getAnimationTimestamp();
  if (now - lastHaptic.value < MIN_HAPTIC_GAP_MS) return;
  lastHaptic.value = now;
  nativeHaptic(kind, hapticIntensity.value);   // sync JSI
}
```

Respect `profiles.haptic_intensity` and system Reduce Motion (`AccessibilityInfo` → shared value; Reanimated's `ReduceMotion` config for springs).

### 4.7 Realtime → shared value, never Realtime → setState

The co-op ingress path is where a naive implementation destroys the frame budget: a squad event arrives on the JS thread, calls `setState`, and re-renders the workout tree *while the user is mid-gesture*. At N=4 this happens four times as often.

**Shared values cannot be created as members join** — hooks are fixed-count, so a dynamically sized squad cannot mean a dynamically sized set of SVs. Preallocate **exactly four slots** at mount and index them by `color_slot`. This is precisely why `color_slot` is `check (between 0 and 3)` and unique per session: the schema constraint exists to serve the render architecture.

```ts
// Allocated once. memberCount only changes which slots are *live*.
const squad = useSquadSlots();            // { progress: SV<number>[4], state: SV<number>[4], ... }

channel.on('broadcast', { event: 'progress' }, ({ payload }) => {
  runOnUI((slot: number, p: number) => {
    'worklet';
    squad.progress[slot].value = withSpring(p, springs.reorder);
  })(payload.slot, payload.progress);     // primitives only — never the payload object
});
```

The rail animates; React never renders — and the cost is flat in squad size, because a join changes a *value*, not the component tree. Note the second detail: only primitives cross into `runOnUI`. Passing `payload` directly would clone the whole object into the UI runtime on every message (§4.2), turning a 4-member squad into four object clones per set.

Durable facts go to Zustand on a debounced, low-priority path (`InteractionManager`, or after the gesture ends) purely so history and reconnect-replay stay correct. The only squad event permitted to re-render the tree is a **join or leave**, which changes `memberCount` — and even then the pods themselves animate their widths from a derived value rather than re-laying out (§6.4).

### 4.8 NativeWind v4 boundary

NativeWind v4 compiles to `StyleSheet` at build time, so static classes are effectively free. But `cssInterop` wraps components and subscribes them to runtime signals (color scheme, container queries, `dark:` variants), which reintroduces re-renders exactly where we don't want them.

**Rule:** inside any animated subtree, `className` is static and literal. No conditional class strings, no `dark:` on animated nodes, no template-interpolated classes. Anything that changes comes from `useAnimatedStyle`. NativeWind styles the skeleton; Reanimated moves it.

### 4.9 Measurement

React DevTools Profiler is nearly useless here — it measures the thread we've deliberately vacated.

- **Xcode Instruments → Animation Hitches / Core Animation**, on a physical ProMotion device. Simulator FPS numbers are meaningless.
- **Dev-only frame sentinel**: a `useFrameCallback` that records `timeSincePreviousFrame` and flags any delta > 8.33 ms with the active gesture name. Cheap, always-on in dev, catches regressions the moment they land.
- **Reanimated strict mode** on in development to catch illegal cross-runtime access early.
- **CI gate**: a scripted swipe-swap and drag-reorder run on a device farm, asserting hitch ratio below a threshold. Motion quality regresses silently otherwise.

---

## 5. Dataset parsing & the biomechanical swap

Source: `hasaneyldrm/exercises-dataset` — 1,324 exercises, `data/exercises.json` + `data/exercises.schema.json`.

### 5.1 What the dataset actually gives us

Measured, not assumed — 1,324 records inspected directly:

| Field | Reality |
|---|---|
| `body_part` | 10 values, clean enum |
| `category` | **Identical to `body_part` in all 1,324 rows.** Redundant; dropped. |
| `target` | 19 distinct, good quality |
| `equipment` | 28 distinct |
| `muscle_group` | 29 distinct — and **not** a grouping of `target`. The dataset's own sit-up has `target: abs`, `muscle_group: hip flexors`. It is the primary *synergist*, so it folds into the secondary set. |
| `secondary_muscles` | 40 distinct |
| `instructions` | 10 languages — the bulk of the 16.6 MB |

**The muscle fields alias heavily across all three**: `traps`/`trapezius`, `lats`/`latissimus dorsi`, `quads`/`quadriceps`, `delts`/`deltoids`/`shoulders`, `abs`/`abdominals`/`core`. The union across the three fields is exactly **50 distinct strings**, which is the size of the hand-audited map.

**What it does not give us — the crux:** no movement pattern, no plane of motion, no joint action, no compound/isolation flag, no unilateral flag. `target`, `equipment`, and `muscle_group` are free-form strings with no enum in the schema.

A swap built on `target` alone would offer a barbell bench press as an alternative to a cable fly — same target muscle, completely different demand, stability requirement, and loading. **The enrichment step is not optional; it is the feature.**

### 5.2 Build-time pipeline (`scripts/build-catalog.ts`)

Runs offline, output committed. Nothing here happens on a device.

1. **Fetch & validate** against the shipped `exercises.schema.json`. Fail the build on drift.
2. **Strip languages** to `en` + supported locales. Ten languages of instructions is the bulk of the payload; dropping the unused ones cuts it dramatically. Additional locales ship as separate downloadable packs.
3. **Canonicalize muscles.** Build `muscle-map.ts`: raw string → canonical key + muscle group + agonist/antagonist relations. Expect ~30–40 distinct `target` values (pectorals, lats, delts, biceps, triceps, quads, hamstrings, glutes, calves, abs, traps, forearms, adductors, abductors, spine, serratus anterior, levator scapulae, upper back, cardiovascular system…). This file is **hand-audited** — it's small, it's the foundation of every swap, and a single mis-mapping produces a visibly stupid recommendation.
4. **Canonicalize equipment** → `load_type` (barbell, dumbbell, kettlebell, cable, machine, smith, band, bodyweight, other) and `stability_demand` (0 machine → 2 free weight).
5. **Derive movement pattern.** Ordered rule classifier over the name combined with the canonical target — neither alone suffices, since "curl" means elbow flexion with target biceps and knee flexion with target hamstrings. **31 patterns**, achieving **87.9% by name rule**, 12.1% by target fallback. Fallbacks are recorded as a distinct `classification` value so the weakest rows can be audited first; a fallback is a guess about the movement, not a reading of it. `data/overrides.json` takes hand corrections for cases rules cannot reach, and the build fails below a 75% rule-coverage floor under `--strict`.

   Classifying `stretch` (56 records) as its own pattern matters more than it looks: it keeps mobility work out of the strength swap pool entirely.
6. **Derive flags:** `is_compound` (pattern class + `secondary_muscles.length >= 2`), `is_unilateral` (name matches `single|one arm|one leg|alternat`), `plane` (from pattern), `skill_level`.
7. **Compute the similarity matrix** (§5.3), keep top-12 per exercise.
8. **Emit** `assets/catalog.db` (SQLite: `exercises`, `exercises_fts` FTS5, `exercise_similarity`, `meta`) + `data/seed/catalog.sql` for Postgres.

**16.6 MB source → 3.54 MB bundled catalog**, with the similarity matrix included. Written with Node's built-in `node:sqlite` (FTS5 available), so the pipeline keeps the zero-dependency property of the rest of the domain. The raw dataset is fetched, not committed; only the derived catalog ships.

```bash
npm run catalog
```

### 5.3 Similarity scoring

Offline, pairwise over 1,324² ≈ 1.75 M — about 2.7 s as a build step:

```
score =
  0.40 × targetMatch        exact canonical target 1.0
                            same muscle region 0.6
                            same body_part only 0.25
+ 0.25 × patternMatch       identical 1.0; same family 0.5
+ 0.15 × jaccard(secondary_canon)
+ 0.10 × planeMatch
+ 0.05 × unilateralMatch
+ 0.05 × (1 − |stability_a − stability_b| / 2)

penalties: identical id (−∞); same variant_key (−∞);
           stretch/cardio crossing into strength (−∞);
           is_compound mismatch (−0.20); skill jump > 1 (−0.15)
```

The `is_compound` penalty stops "bench press → cable fly" from ranking. `reason` is persisted as JSONB so the card can say *why* — "same target, same push pattern, dumbbell instead of barbell".

**Relevance ranking alone produces an unusable list, and this is the part worth understanding.** Measured on the real data, **48% of similarity rows score ≥ 0.999**: every compound barbell horizontal push for the chest is biomechanically identical by every structured field, so they all tie at 1.0 and the tiebreak falls through to exercise id — effectively alphabetical. `barbell bench press` returned five barbell bench variants, six dumbbell bench variants, and one push-up. Nobody swipes to swap a bench press for a slightly different bench press; they swipe because **the bench is taken**.

Two mechanisms fix it:

- **`variant_key`** — the dataset ships ~78 records that are the same movement rendered differently (`v. 2`, `(male)`, `(back pov)`). `barbell full squat` was offering `barbell full squat (back pov)` as an alternative. Records sharing a variant key are hard-excluded from each other's candidates but stay in the catalog, since the app can group by the key for browsing.
- **Diversified top-K (maximal marginal relevance)** — each pick is the best candidate *given what has already been picked*, penalised by a redundancy term combining biomechanical score, name overlap, and **load type**. Load type appears in redundancy but deliberately **not** in relevance: a dumbbell press is a perfectly good substitute for a barbell press, so penalising it there would be wrong — but needing different equipment is the single most useful way one alternative differs from another.

The result for `barbell bench press` is now barbell decline press, **bodyweight** decline push-up, **dumbbell** bench press, **loaded-bodyweight** svend press, **medicine ball** chest pass — five distinct load types in the top five.

Note that `rank` is therefore **selection order, not score order**: rank 0 is still the strongest match, but rank 3 may score below rank 4. The app should always `order by rank`.

### 5.4 Runtime re-ranking (on-device, <1 ms)

The static matrix is muscle-aware but not *user*-aware. At card mount, re-rank the top-12:

```
final = score
      × (equipment available in profiles.available_equipment ? 1.0 : 0.35)
      × (user has logged history for this exercise ? 1.25 : 1.0)   // weight prediction exists
      × (already present in today's workout ? 0.0 : 1.0)
      × (same pattern already trained today ? 0.7 : 1.0)           // fatigue awareness
      × (user-blacklisted ? 0.0 : 1.0)
```

The history multiplier closes the loop with "lazy logging": a swap preferentially lands on an exercise the app can already predict a weight for, so the swap costs the user zero typing.

### 5.5 Media

1,324 animated GIFs at 180×180. GIF decoding is per-frame CPU work and will fight the 8.33 ms budget directly.

- **Transcode offline** to animated WebP (or HEVC/MP4 for longer loops); serve from Supabase Storage behind a CDN.
- **Bundle** the ~200 most common exercises; lazy-download the rest on first use.
- `expo-image` with `recyclingKey`, `cachePolicy: 'memory-disk'`, and explicit `prefetch` for the swap ring's candidates.
- **Pause animation on offscreen ring cards** — three simultaneously decoding animations is pure waste.
- 180×180 is low for a modern full-width card. Either present the media small and sharp (a thumbnail alongside a static illustration) or accept upscaling. Worth deciding deliberately rather than discovering on device.

### 5.6 Licensing flag

Every record carries `attribution: "© Gym visual — https://gymvisual.com/"`, and the repo ships a `NOTICE.md` alongside its `LICENSE`. **The media is third-party licensed.** Before shipping — certainly before monetizing — read `NOTICE.md` and confirm the terms cover commercial redistribution, including our transcoding and CDN re-hosting. Attribution must be surfaced in-app regardless. This is a blocker to resolve early, not at submission time; the text metadata and the media may well carry different terms.

---

## 6. Squad mechanics (2–4 members)

### 6.1 Rest is derived, and it gets *worse* as the squad grows

Rest is not an input at N > 2. It falls out of the rotation:

```
predicted_rest(m) = Σ over other active members of (avg_work_s + transition_s)
```

With `work = 40 s`, `transition = 10 s`:

| Squad | Predicted rest | vs. 90 s target |
|---|---|---|
| 2 | ~50 s | too **short** |
| 3 | ~100 s | about right |
| 4 | ~150 s | too **long** |

`avg_work_s` is *measured*, not assumed — derived from `turn_started_at` to set completion and kept as a rolling average, so cadence prediction sharpens over the session.

Bloat and starvation surface through **different signals**, which is not obvious until you build it:

- **Bloat** shows up as `rest_pressure = observed_rest / rest_target_s > 1.35`. The rotation forces more rest than anyone wanted.
- **Starvation does not show up as short rest at all**, because a station that respects rest targets *waits* rather than letting someone lift early. It shows up as **idle share** — the fraction of the session with nobody under the bar. Above 20%, the rotation is too thin to fill the rest. (The rest-pressure floor of 0.75 is retained for schedules that refuse to idle.)

A solo lifter is exempt from the idle test: lifting alone means idling between your own sets by definition, which is rest, not a scheduling defect.

Responses:

- **Bloated** — split the station (4 → 2 + 2 roughly halves it), or insert an antagonist filler for waiting members.
- **Starved** — merge stations or add a filler set between turns.

This implies an opinionated default: **a 4-person squad starts as two stations of two.** One bar for four people is the exception (spotting, a single heavy platform), not the norm, and the schema treats it that way. The "everyone on one bar" case still works — it's just not the default a squad of four falls into.

### 6.2 Turn ordering: two modes, and the tension between them

Within a round, ordering members by load **monotonically** is optimal: ascending means every transition only *adds* plates, descending only *removes*. Any other order forces both on every changeover. So intra-round ordering is settled.

The round boundary is where the real trade-off lives:

| Mode | Order | Plate cost | Rest cost |
|---|---|---|---|
| **Even** (fixed) | 60→80→100→120, reset | Full strip (120→60) every round | Perfectly uniform: everyone gets exactly (N−1) turns |
| **Flow** (serpentine) | 60→80→100→120 ǀ 120→100→80→60 | **Zero** at the boundary | Boundary lifter goes back-to-back |

Neither dominates, so **`auto` scores candidate schedules rather than applying a rule.** An earlier draft of this section proposed picking serpentine whenever `rest_pressure > 1.2`, on the theory that a bloated rotation makes the boundary lifter's short rest a feature. Implementing and measuring it showed that reasoning is wrong, and the correction is worth recording:

- The idle policy is a second axis. A schedule can absorb a short boundary rest by making the station *wait* — so ordering and rest are not the either/or the rule assumed. Strategies are the cross product: `fixed`, `fixed-idle`, `serpentine`, `serpentine-idle`.
- **Plate moves are already inside total time**, because the transition model charges for them. Ranking moves above time double-counts a proxy against the quantity it approximates. Scored that way, a 4-person squad picks `serpentine-idle` — saving 6 plate moves (~24 s of handling) at the cost of ~144 s of everyone standing around, because the boundary lifter's forced idle never shows up in a plate count.

The scoring order is therefore **rest debt → total time → plate moves**, with moves surviving only as a tie-break. Rest debt leads because it is a training-quality failure, not an inconvenience.

Measured on a 4-person squat squad (62/81/100/122 kg, 90 s target, 3 rounds), `auto` selects `fixed`: 23 plate moves, 11.1 min, zero idle — beating `serpentine-idle` at 17 moves and 13.5 min. At N=2 it selects `fixed-idle`, rest pressure exactly 1.0. Serpentine still wins where rest targets are short enough that the boundary costs nothing — circuit and EMOM work — which is the case it was always actually right for.

`sync_stations.direction` flips at the boundary when a serpentine strategy is chosen; `next_in_rotation()` honours it. Users can pin `flow` or `even`. This surfaces as one line of copy at station setup, never a settings screen.

### 6.3 Asymmetric load

Every member's `planned_load_kg` comes from **their own** `exercise_progression` (last sets + `trend_kg_per_session`). That independence is the asymmetry; nothing about the squad touches an individual's prediction.

The plan is then computed server-side, once, so all N clients agree:

1. **Achievable-load lattice.** From `bar_weight_kg` + `plate_inventory`, enumerate every achievable total once per session, sorted. Snapping a target to the nearest achievable becomes a binary search, cheap enough to run inside a worklet if a scrub gesture needs live feedback. Ties snap downward — overshooting a predicted load is the worse failure.
2. **Snap** each member's predicted load to the lattice.
3. **Plate-solve** per side. **Not greedy** — greedy largest-first is wrong, not merely suboptimal: with plates {25×1, 20×1, 15×1}, a 35 kg side is reachable as 20+15, but greedy takes the 25 and then cannot finish, reporting "unachievable" for a load the gym can make. This is a bounded knapsack, solved one layer per denomination so the chosen counts reconstruct exactly.
4. **Solve the sequence, not each load.** Minimising plates *used* per turn is the wrong objective; what costs time is plates *moved* between turns. Going 60 → 80 kg, an isolated solver may pick [25,5] then [20,10,10] — five plates handled — where [20] then [20,10] is one. Each step is therefore solved as a minimal delta from the bar's current state: keep as much as possible, add from the rack, or strip the least. An ascending round becomes pure additions with zero strips.
5. **Diff consecutive slots** → `{add:[…], remove:[…]}`, and estimate `transition_s ≈ 8 + 4 × (|add| + |remove|)`, calibrated later against measured turn deltas. This feeds straight back into §6.1's cadence math — heavier plate churn means longer rest, and the app knows it.
6. Emit `station_turn_plan`.

*Known limitation:* the sequence solver is greedy across turns — each step is optimal given the previous configuration, but the *first* configuration is chosen without lookahead. Opening a descending sequence with [25,25] is the fewest plates but decomposes badly, where [20,10,10,10] costs more up front and then strips one plate per turn. Making this optimal is a shortest path over configurations; it is worth doing only if measured transition times justify it.

All mass arithmetic runs in integer centi-kilograms. Plate math is full of values like 1.25 and 2.5 that do not survive binary floating point, and `62.5 === 20 + 2 * 21.25` failing is how you ship a bar the app insists is loaded wrong.

Replan triggers: join, leave, manual load edit, `stalled`, round boundary. Each bumps `plan_version`; clients diff by version and **animate** the delta rather than re-rendering the plan.

**Display normalization — the social problem.** Four friends of different bodyweights on one bar produce four very different numbers. Rendering raw kilos side by side turns training into a leaderboard and is actively demotivating for the smallest lifter. So:

- The squad rail shows **`relative_intensity`** (fraction of that member's own e1RM) plus set progress — comparable, non-hierarchical, and the more useful signal anyway.
- Absolute kilos appear in exactly two places: **your own card**, and the **on-deck plate prompt** — where the number is a logistics instruction, not a comparison.

### 6.4 Zen Mode

Governing rule: **one focus on screen, and you are never in the rail.**

- You are the main card; the rail renders the *other* 1–3 members. Rail element count is 0–3, never 4 — that single decision removes most of the clutter problem before any visual design starts.
- **Attention hierarchy, exactly one emphasis at a time**, resolved by priority: (1) your rest ending (< 5 s), (2) you're on deck → plate prompt, (3) someone else mid-set → their pod, (4) idle. Emphasis is a single shared value `focusIndex`; pods interpolate scale/opacity from it. Two things never pulse at once.
- **Layout stability.** Rail height is reserved permanently — solo sessions render it full-height at zero opacity. Joining a squad mid-workout never reflows the workout card. Zero layout thrash on join/leave, the same construction as the swap ring (§4.4).
- **N-scaling without breakpoints.** Pod width is derived: `w = (railWidth − gaps) / max(memberCount − 1, 1)`. Internal content fades via `interpolate(podWidth, [COMPACT, WIDE], [0, 1])`, so a 2-person squad shows one rich wide pod and a 4-person squad shows three compact glyph pods — transitioning *continuously* rather than snapping at a JS breakpoint. A member joining is a spring on every pod's width, not a re-layout.
- **Progressive disclosure.** One gesture: drag the rail down for the full squad sheet (names, loads, history). Nothing that isn't glanceable lives in the collapsed rail.
- **Identity by hue, not name.** `color_slot` (0–3) is assigned at join and stable for the session. Ring and fill carry state; no text at the ambient level.
- **The one line that replaces four status displays:** *"You're up in ~40 s · bar 100 → 80."* At N=4 that sentence is worth more than every other member's full state combined. Getting it right is most of the Zen Mode design.

### 6.5 Haptic budget — O(1) in squad size

The naive failure mode is four members × events per set, producing a phone that buzzes continuously and teaches the user to ignore it.

- **Self-relevant events only, at full intensity**: your rest ending, your turn starting, your PR.
- **One light tick** when the member immediately before you finishes — your on-deck cue. Nothing for anyone else.
- **One squad-wide synchronized pulse** at round completion, scheduled locally against the shared timestamp (§2.5) so all four phones fire together.
- Global limiter: max one haptic per 400 ms, priority-ranked, with lower-priority events **dropped rather than queued** — a late haptic is worse than no haptic.

Total haptic rate is therefore identical at N=4 and N=2.

---

## 7. Progression prediction (lazy logging)

The pillar the whole product rests on: by the time a set renders, its weight and rep target are already filled in, so finishing a set is one tap rather than two number entries. Everything here is pure and deterministic — `now` is injected rather than read from the clock, so a prediction is reproducible and testable.

### 7.1 Output

A prediction is **per set**, not one number: `[{setIndex, weightKg, reps, isTopSet}]`, plus a `confidence`, a `source`, and a one-line `rationale` shown under the prefilled numbers. The suggestion is never a black box — *"You hit 12 reps across the board — adding 2.5kg"* is the difference between a user trusting the prefill and checking it every time.

Two values feed the rest of the system: `plannedLoadFrom(prediction)` becomes `sync_members.planned_load_kg` for the rotation planner (§6.3), and `relativeIntensity` becomes the squad rail's display metric.

### 7.2 e1RM

Epley (`w × (1 + r/30)`), **capped at 12 reps to match the `sets.e1rm` generated column exactly**. Beyond ~12 the estimate degrades badly, and a client that disagreed with the database about whether something was a PR would be worse than no estimate at all. The cap is a consistency requirement, not a modelling preference.

### 7.3 Trend fitting: Theil-Sen, not least squares

The trend is the median of all pairwise slopes across session-best e1RM.

Least squares is the obvious choice and it is the wrong one for training logs. One deload week, one session cut short because the rack was busy, or one heavy single is enough to swing an ordinary regression line — and that line sets next week's prescription. Theil-Sen tolerates up to ~29% of points being garbage, which is roughly what a real log looks like. Verified directly: a five-session series with one deload dropped in produces an identical slope to the clean series.

### 7.4 The decision ladder

Evaluated in order, first match wins:

| Condition | Action | Source |
|---|---|---|
| `consecutive_failures ≥ 2` | Back off to 90% | `deload` |
| `consecutive_failures = 1` | Same weight, same target | `repeat` |
| Hit top of rep range, trend healthy | +2.5 kg, reps reset to bottom of range | `progression` |
| Hit top of rep range, **trend flat or negative** | Hold weight one more session | `repeat` |
| Mid-range | Same weight, one more rep | `repeat` |

The fourth row is the non-obvious one. Double progression alone would add weight the moment reps are hit; blocking that when the measured trend is negative stops the app cheerfully walking a stalling lifter into a failed set. Detraining decay (§7.7) is applied on top and overrides the rep target.

### 7.5 Set shape is learned, not assumed

Someone running a heavy top set with back-offs must not be handed three identical numbers to correct by hand — that is precisely the typing lazy logging exists to remove. Ratios are taken against the heaviest set in the last session and reapplied to the new top set, then each is snapped to the lattice independently. Straight sets fall out of this naturally; so does a 100/90/80 descending shape.

### 7.6 Cold start and swap transfer

A brand-new exercise has no history — and after a Swipe-to-Swap (§4.4), that is the *common* case, not the edge case.

- **With a related lift**: scale from it by a caller-supplied ratio, then take a further 10% off. A first attempt at an unfamiliar movement should be too light rather than a failed set in front of the squad. Confidence `low`.
- **With nothing**: the bare bar, confidence `none`, and the app says so.

The transfer ratio is **an input, not a constant in this module** — it belongs to the exercise catalog alongside the similarity matrix (§5.3), and inventing a number in the predictor would be worse than requiring one. Populating it is catalog work, and it pairs naturally with the swap ring: the exercise you swapped *from* is the obvious transfer source.

### 7.7 Detraining

Layoffs decay the prediction: a grace period (14 days), then ~2.5% per week, floored at 70%. Same status as the plate transition model — plausible rather than measured, and flagged for calibration once real return-from-layoff sessions exist. The rationale line changes to match (*"6 weeks off — starting back at about 89% of your last working weight"*), because silently predicting a lower weight than last time would read as a bug.

### 7.8 Confidence

Four levels driving how assertively the UI presents the prefill: `none` (no history), `low` (one session, transferred, or stale), `medium` (2–3 sessions), `high` (4+ recent sessions). This is what lets the card render a confident number versus a soft suggestion without a separate heuristic in the view layer.

---

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Media licensing** (§5.6) | Ship blocker | Read `NOTICE.md` now; have a fallback illustration set scoped |
| Gym connectivity | Co-op dies | End-timestamp timer design (§2.5) survives disconnects; full offline logging; optional BLE/Multipeer local transport as a later phase |
| One member drops mid-round | Squad of 4 blocks on one phone | `turn_deadline_at` + auto-skip past `stalled` (§2.5); rejoin at round boundary |
| Concurrent "I'm done" at N=4 | Corrupted turn state | CAS `advance_turn()`; `turn_cursor` also orders broadcasts (§2.4) |
| Rest bloat at N=4 (~150 s) | Training quality drops | `rest_pressure` monitoring; default 4 → two stations of two; serpentine pacing (§6.1–6.2) |
| Raw kg shown side by side | Demotivating for smaller lifters | Rail displays relative intensity only; absolute kg on your card + plate prompt (§6.3) |
| Haptic spam scaling with N | Users disable haptics — kills a core pillar | Self-relevance filter + 400 ms limiter; O(1) in squad size (§6.5) |
| A wrong prefill sends someone into a failed set | Users stop trusting lazy logging entirely | Trend guard blocks increases during a stall; deload ladder; transfers undershoot by 10%; confidence shown (§7.4–7.8) |
| Transfer ratios unpopulated | Every swap cold-starts at the bare bar | Catalog work alongside the similarity matrix; swap source is the natural default (§7.6) |
| Detraining + transition constants are guesses | Predictions drift from reality | Both isolated as named models with a single definition site; calibrate against measured sessions |
| `runOnJS` haptic latency | Undermines the core promise | Instrument in Phase 1; sync JSI module in Phase 2 (§4.6) |
| Movement-pattern classification quality | Bad swap suggestions | 87.9% by rule; fallbacks flagged for audit; `overrides.json`; 75% floor enforced under `--strict`; in-app "why this?" + feedback loop |
| Upstream dataset drift | Silent swap-quality regression | Build hard-fails on unmapped muscles or equipment; `fetch-dataset.ts` should be pinned to a commit SHA before launch (currently tracks `main`) |
| Reanimated 3→4 / New Arch migration | Rework | Decide before scaffold, not after (§0) |
| No Expo Go | Onboarding friction | Dev Client + EAS from commit one |
| 120 fps on older devices | Inconsistent feel | Tune springs by `dampingRatio`/`duration` (refresh-independent); device-tier gate on decorative effects |

---

## 9. Proposed build order

1. **Foundation** — Expo + Dev Client + New Arch + NativeWind v4 + `CADisableMinimumFrameDurationOnPhone` + frame sentinel. Prove 120 fps with a throwaway spring before anything else.
2. **`src/motion/`** — `springs.ts`, `usePressScale`, `useHapticEngine`. The motion vocabulary comes first; every screen inherits it.
3. **Catalog pipeline** — `scripts/build-catalog.ts` → `catalog.db`. Ship the browser screen (FlashList over 1,324 items) as the first real perf test.
4. **Workout player, solo** — card ring, `ScrubNumber`, `SetRow`, drag-reorder, prediction from `exercise_progression`.
5. **Swipe-to-Swap** — needs 3 and 4 in place.
6. **Supabase + offline outbox** — auth, sync, history.
7. **Co-op** — build for N=4 from the first commit, then verify N=2 as a special case. The reverse order means retrofitting stations, CAS turn advancement, and preallocated squad slots into code that assumed a single partner — which touches the schema, the transport, and the render tree at once. Order within the phase: channels + presence → stations & CAS rotation → per-member timers → plate solver & turn plan → Zen Mode rail → synchronized haptics.

Steps 1–2 are non-negotiably first. Retrofitting 120 fps onto a built app means rewriting every component that touches a gesture.

**Status: all seven steps are code complete. None has run on hardware or against a live Supabase project.**

- **Step 1 — foundation.** Expo SDK 57 / RN 0.86 / New Arch, NativeWind 4, Reanimated 4, `CADisableMinimumFrameDurationOnPhone` verified present in the resolved config, expo-doctor 20/20. The 120 Hz *number* comes from `app/proof.tsx` on a physical ProMotion device — see §4.0. It cannot be produced on a simulator or a desktop, and the harness says so on screen rather than reporting a meaningless host-display figure.
- **Step 2 — motion primitives.** `src/motion/`: `springs.ts` (the single token file), `useFrameSentinel`, `usePressScale`, `haptics.ts`, `LiveNumber`, `useScrubNumber`, `useSortable`, `useCardRing`.
- **Step 3 — catalog pipeline.** As in §5.
- **Step 4 — solo player.** `src/data/catalog.ts`, `src/state/workout.ts`, `SetRow`, `ExerciseCard`, `app/workout.tsx`. Predictor wired end to end.
- **Step 5 — Swipe-to-Swap.** `src/domain/swipe.ts`, `useCardRing`, `SwapRing`. Prediction transfers from the outgoing exercise when the equipment matches.

Verified on every change with `npm run verify` (typecheck → 181 tests → migrations → iOS bundle).

**Nothing built so far has run on hardware.** Steps 1, 4 and 5 each carry device-only acceptance criteria — the 120 Hz verdict, logging a workout without touching the keyboard, and holding `pass` mid-swipe. Those are tracked in `docs/HANDOFF.md` §5 and are not counted as build steps.

The domain behind §6–§7 was built and tested ahead of the UI — `src/domain/` (plate lattice and sequence solver, rotation strategies, cadence analysis, progression predictor, similarity scoring, runtime re-ranking, swipe resolution) and `scripts/catalog/` (the build pipeline). Zero runtime dependencies, no React. Runs on Node's native TypeScript and `node:sqlite`, so neither `npm test` nor `npm run catalog` needs a build step.

Four claims in this document were corrected by implementing them, plus one column added:

| Corrected | Where |
|---|---|
| Pacing-mode rule — scoring, not a rest-pressure threshold | §6.2 |
| Starvation surfaces as idle share, not short rest | §6.1 |
| Plate solver optimises moves across a sequence, not plates per turn | §6.3 |
| Relevance ranking alone returns twelve near-identical swaps | §5.3 |
| `exercise_progression.consecutive_failures` added | §2.2 |

Two tests to keep green above all others:

- `tests/pipeline.test.ts` — four training histories → four predictions → one rotation with a plate plan, asserting every predicted load survives planning unchanged and is physically loadable. If it breaks, somebody has to type a number.
- `tests/catalog.test.ts` — the diversity regression, asserting a top-12 spans equipment rather than enumerating one movement's variations. If it breaks, Swipe-to-Swap offers you the same exercise twelve times.
