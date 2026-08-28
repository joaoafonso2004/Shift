# Shift — implementation handoff

**Read this before touching anything.** It is the entry point; [PHASE1_ARCHITECTURE.md](./PHASE1_ARCHITECTURE.md) is the reference manual behind it. Section numbers below (§4.4, §6.2, …) point into that document.

Shift is an iOS gym app for iPhone where **motion is the product**: 120 fps ProMotion, gesture-driven, one-tap set logging, live swap-to-alternative, and a 2–4 person shared "Sync Session". React Native + Expo, NativeWind, Reanimated 4, Supabase.

---

## 1. Start here

```bash
npm install
npm run verify
```

| Command | What it does |
|---|---|
| `npm test` | 296 tests, Node's native runner, no build step |
| `npm run typecheck` | TypeScript 6, strict, covers app + domain + scripts |
| `npm run bundle:check` | Metro bundle for iOS — catches native-side breakage on any OS |
| `npm run verify` | All three. **Run before declaring anything done.** |
| `npm run db:start` | Local Supabase stack in Docker. Fetches the CLI through `npx`; the first run also pulls several GB of images |
| `npm run db:test` | 38 row-level-security assertions against the real stack |
| `npm run db:reset` | Re-apply every migration from scratch |
| `npm run catalog` | Rebuild the exercise catalog from the upstream dataset |
| `npm run ios` | Device build. Needs macOS + Xcode + a physical iPhone |

**`npm run verify` is the contract.** It runs on Windows, macOS, or Linux and catches everything except device behaviour. It deliberately does **not** include `db:test`, which needs Docker — keeping verify runnable anywhere is worth more than folding the two together.

---

## 2. What exists, and how much to trust it

| Area | State |
|---|---|
| `src/domain/` — plate solver, rotation, cadence, progression, similarity, swipe | **Done and tested.** Pure TypeScript, zero deps, no React. Treat as stable; change only with a failing test first. |
| `scripts/catalog/` + `assets/catalog.db` | **Done.** 1,324 exercises, 15,888 similarity rows, 3.54 MB. Rebuild with `npm run catalog`. |
| `src/motion/` — springs, frame sentinel, press scale, haptics, scrub, sortable, card ring | **Done, unverified on device.** Logic is tested; feel is not. |
| `src/data/catalog.ts` — SQLite reader | **Done.** Bundled DB copied on first launch, versioned by build id. |
| `src/data/localSchema.ts` + `repository.ts` — offline-first store and outbox | **Done and tested** against the real SQLite engine. |
| `supabase/migrations/` — 8 migrations | **Applied.** All eight run clean against Supabase's own Postgres 17 locally, and `data/seed/catalog.sql` loads 1,324 exercises and 15,888 similarity rows into them. Never applied to a *hosted* project. |
| `supabase/tests/rls.sql` — row level security | **Done and passing.** 38 assertions, real roles, real `auth.uid()`. |
| `src/data/supabase.ts`, `sync.ts` — client and outbox flush | **Written, never run.** No project, no credentials. |
| `src/state/workout.ts` — session store (Zustand) | **Done.** Writes through to the local database. |
| `app/` — home, `workout.tsx`, `proof.tsx` | **Solo player + swap work.** Prefilled sets, scrub-to-edit, tap-to-log, drag-reorder, swipe-to-swap. |
| `src/domain/coop.ts` — rotation, focus, on-deck, haptic relevance, timers | **Done and tested.** 31 tests. |
| `src/motion/useSquadSlots.ts`, `src/features/coop/` — slots, clock, squad rail | **Written, unverified on device.** |
| `src/data/coopChannel.ts`, `auth.ts`, `session.ts`, `src/state/coop.ts` | **Written, never run.** Needs a live project and anonymous sign-in enabled. |
| `src/domain/joinCode.ts` + `app/squad.tsx` — create/join a squad | **Done and tested** (12 tests). UI unverified on device. |
| `src/data/station.ts` + `useCoop.finishTurn` — turn rotation | **Written, never run.** CAS advance wired to completing a set. |
| `src/domain/theme.ts` — 5 surfaces x 6 accents | **Done and tested.** All 30 pairings verified against WCAG AA. |
| `src/domain/settings.ts`, `src/state/settings.ts`, `app/settings.tsx` | **Done and tested** (20 tests). UI unverified on device. |
| `src/domain/friends.ts` — friendship state machine, handles, visibility | **Done and tested.** 32 tests. |
| `supabase/migrations/0006_friends.sql` — friendships, avatars, reports | **Applied and RLS-tested.** Friendship helpers, profile visibility and the avatar policies all behave as documented. |
| `src/data/friends.ts`, `avatars.ts`, `app/friends.tsx` | **Written, never run.** Needs a live project and the `avatars` bucket. |
| `src/domain/sharing.ts` — shared payload, parser, substitution, links | **Done and tested.** 26 tests. Pure, zero deps. |
| `saved_routines` in `localSchema.ts` + repository | **Done and tested** (10 tests) against the real SQLite engine. |
| `supabase/migrations/0008_sharing.sql` — `shared_routines` | **Applied and RLS-tested.** Its first draft had three real holes; see the traps table. |
| `src/data/shares.ts`, `routines.ts`, `ShareSheet`, `app/routines.tsx` | **Written, never run.** The link half works offline; the friend half needs a live project. |
| `app/_layout.tsx` deep links + `src/state/inbound.ts` | **Written, unverified on device.** Needs a Dev Client build to test a real `shift://` open. |

`seedHistory.ts` is gone. History now comes from the device-local database, so a first launch genuinely cold-starts every exercise and predictions sharpen as the user trains.

### The one thing that is not proven

**120 fps has not been measured.** The scaffold verifies green — expo-doctor 20/20, `CADisableMinimumFrameDurationOnPhone` confirmed present in the *resolved* config, iOS bundle succeeds — but nobody has run it on hardware. A simulator reports its host display and means nothing.

To close this out, on a physical iPhone 13 Pro or newer: `npm run ios`, open **Frame sentinel**, read the verdict (§4.0). Report the number and the load at which it degrades. Until then, treat "120 fps" as designed-for, not achieved.

---

## 3. Invariants — do not break these without a deliberate decision

These were each paid for once. Re-litigating them costs the same again.

### Motion

1. **No `setState` inside a gesture.** Not in `onBegin`, `onUpdate`, or `onEnd`. State commits once, on `onFinalize`, via a single `runOnJS` with a complete payload.
2. **Pass shared values into children, never numbers.** A changing number prop is a re-render; a shared value is a stable ref. Every row component is `React.memo`'d.
3. **Only primitives cross `runOnJS` / `runOnUI`.** Passing an object clones it into the other runtime on every call. An exercise record carries ten languages of instructions.
4. **Springs, never timings, for anything a finger can grab.** Springs retarget mid-flight; timings snap. Seed every release with gesture velocity.
5. **All spring configs come from `src/motion/springs.ts`.** No inline configs anywhere. Configs use `duration` + `dampingRatio` because that form is refresh-rate independent.
6. **Static, literal `className` only inside animated subtrees.** NativeWind's `cssInterop` subscribes components to runtime signals. Anything that changes comes from `useAnimatedStyle`.
7. **Pre-mount everything a gesture can reach.** Mount cost inside a gesture lands exactly where the user is looking.
8. **Realtime → `runOnUI` → shared value. Never Realtime → `setState`.** A partner event must not re-render the workout tree mid-gesture.
9. **One continuous value per gesture where possible.** The card ring animates a single fractional `position` rather than a drag offset that resets on commit — a reset flashes the outgoing card for a frame, because the shared value changes immediately while React state lands later.

### Squad

10. **Exactly four shared-value slots, preallocated at mount, indexed by `color_slot`.** Hooks are fixed-count, so a dynamically sized squad cannot mean dynamically sized shared values. This is *why* the schema constrains `color_slot` to 0–3 — the DB constraint exists to serve the render architecture.
11. **You are never in the squad rail.** It renders the *other* 1–3 members, so its element count is 0–3. This keeps Zen Mode uncluttered structurally rather than visually.
12. **Rail height is reserved permanently**, zero-opacity when solo. Joining a squad mid-workout must never reflow the workout card.
13. **Absolute weights never appear in anything social.** The squad rail shows relative intensity; friend stats show consistency and PR *events* with the number stripped. `shareAbsoluteWeights` and `showAbsoluteLoads` are both off by default. Four people of different bodyweights comparing kilos turns training into a leaderboard, and the smallest lifter loses every time.

    This extends to sharing, and there it is enforced by a **type, not a filter**: `SharedExercise` in `src/domain/sharing.ts` has no weight field, so a load cannot travel even by accident. Do not add one. A receiver's loads come from their own history, which is also the only version of the number that means anything to them.
14. **Haptics are O(1) in squad size.** Self-relevant events only, one tick for the person before you, one squad pulse per round, 400 ms limiter, lower priority dropped not queued.

### Data

14. **Rank order, never score order — including inside `rerankAlternatives`.** Rank is *selection order* from the build-time diversity pass; rank 3 can legitimately score below rank 4. Roughly **half of all similarity rows tie at 1.000**, so any score sort collapses the diversification. Runtime multipliers are applied to a rank-derived base (`RANK_DECAY`), never to the stored score. See §5.3.
15. **Load type belongs in redundancy, not relevance.** A dumbbell press is a fine substitute for a barbell press; penalising that in similarity would be wrong. But needing different kit is the most useful way two alternatives differ. Getting this backwards returns twelve bench presses.
16. **All mass arithmetic in integer centi-kilograms** (`src/domain/units.ts`). Plate math is full of 1.25 and 2.5.
17. **Predicted loads are already snapped to the lattice.** `planStation` must return them unchanged. `tests/pipeline.test.ts` asserts this — if it breaks, a user has to type a number.
18. **The catalog build hard-fails on unmapped muscles or equipment.** A new value upstream must be a human decision. Do not add a fallback branch.
19. **Pure logic lives in `src/domain/`.** `src/data/` and `src/state/` import expo and zustand, so Node tests cannot reach them. This is why `latticeFor`, `toFtsQuery` and `resolveSwipe` live in the domain.

---

## 4. Traps already hit — do not rediscover these

| Trap | Reality |
|---|---|
| `"type": "module"` + Babel/Metro | Configs must be `.cjs`: `babel.config.cjs`, `metro.config.cjs`, `tailwind.config.cjs`. |
| `.ts` extensions in imports | Required by Node's type stripping, and Metro resolves them via extended `sourceExts`. One codebase serves both runtimes — **do not "fix" the extensions.** |
| `_getAnimationTimestamp` | Removed in Reanimated 4. `useTimestamp` is a hook, unusable in a worklet. Use `Date.now()`. |
| `Animated.SharedValue` | No longer a namespace type. Import the named `SharedValue`. |
| Worklets Babel plugin | `react-native-worklets/plugin`, and it **must stay last**. |
| `require()` inside a worklet | Does not work — worklets cannot resolve modules at runtime. Import at module scope. |
| TypeScript 6 | Needs `types: ["node"]` explicitly, and `declare module '*.css'` for the `global.css` side-effect import. |
| `expo-build-properties` | iOS `deploymentTarget` must be at least `16.4`. |
| Metro + the `.db` asset | `assetExts` must include `db`, or the bundled catalog is treated as source and fails to parse. |
| Greedy plate solving | Not merely suboptimal — **incorrect**. With plates {25x1, 20x1, 15x1}, greedy calls a reachable 35 kg side unachievable. It is a bounded knapsack. |
| `LinearTransition` for drag-reorder | Wrong tool. It reacts after the commit and fights the finger. Use a manual `positions` shared value plus per-row springs. Keep `LinearTransition` for insert/remove. |
| Absolutely positioned sortable rows | The container has no intrinsic height. Set it explicitly: `sets.length * SET_ROW_HEIGHT`. |
| `onStart` for press feedback | Waits ~130 ms for tap recognition. Use `onBegin`. |
| Expo Go | **Cannot run this app.** Custom native modules and the 120 Hz key need a Dev Client build. |
| `WITH CHECK` cannot pin a column | It is evaluated against the **new** row and cannot see the old one, so a column it does not mention is simply unconstrained. `0008` originally claimed the with-check pinned `from_user_id` and `payload`; a recipient could rewrite an incoming share to look as though anyone had sent them anything. **Column-level `GRANT UPDATE (col, …)` is the only thing that makes a column immutable.** |
| `USING` filters, `WITH CHECK` raises | A row excluded by a USING clause is invisible to the statement, so the UPDATE or DELETE succeeds affecting zero rows. Any client reading only `error` is told it worked — which is exactly what `respondToShare` did before `.select()` was added to it. |
| `grant all` includes TRUNCATE, and RLS does not apply to TRUNCATE | Not reachable through PostgREST, but true of every table here that still carries Supabase's default grants. |
| An expo import inside `src/data/routines.ts` | `tests/workout.test.ts` imports `STARTER_ROUTINE`, and Node cannot resolve `expo-crypto`. The constant lives alone in `src/data/starterRoutine.ts` for exactly that reason — do not move it back. |
| PowerShell `Get-Content \| Set-Content` on docs | Mangles UTF-8 into mojibake on Windows PowerShell 5.1. Edit files with the editor tools, not shell round-trips. |

---

## 5. Next steps, in order

### Step 4 — Solo workout player *(code complete, unverified on device)*

Built: `src/data/catalog.ts`, `useScrubNumber`, `useSortable`, `src/state/workout.ts`, `SetRow`, `ExerciseCard`, `app/workout.tsx`. Predictor wired end to end.

**Scrubbing moves an index into the lattice, not a value.** The step list *is* the achievable-load list from the plate solver, so an unloadable weight is unreachable by construction — no rounding pass afterwards. Travel per step shrinks with drag velocity; each crossed detent ticks the haptic gate.

### Step 5 — Swipe-to-Swap *(code complete, unverified on device)*

Built: `src/domain/swipe.ts`, `useCardRing` + `useRingSlotStyle`, `SwapRing`, wired into `ExerciseCard`. Swapping transfers the prediction from the outgoing exercise (§7.6) when the equipment matches.

- **Slots are keyed by `candidateIndex % 3`**, so advancing the ring changes props on three long-lived components rather than unmounting one card and mounting another.
- **Only same-equipment swaps transfer a predicted weight** (ratio 1.0). Across equipment there is no honest ratio yet — a dumbbell press is quoted per hand, a stack is arbitrary — so those cold-start instead. Cross-equipment ratios remain the open task in §7.6.
- Candidates are queried **once at mount**, an indexed local read, so nothing is fetched or measured during the gesture.

### Remaining for steps 4 and 5 — device only

1. Log a full workout without opening the keyboard. **This is the acceptance criterion and it has not been exercised.**
2. Confirm the frame sentinel reads `pass` while scrubbing, reordering, and mid-swipe with a full set list rendered.
3. Tune by feel: `pxPerStep` (26/13/6) in `useScrubNumber`, `COMMIT_DISTANCE` (0.28) and `COMMIT_VELOCITY` (550) in `swipe.ts`, and whether `rotateY` 26° reads as a morph or a gimmick at 120 Hz.
4. Decide whether the 400 ms haptic limiter is too coarse for scrub detents — `tick` may need its own shorter window.

### Step 6 — Supabase + offline outbox *(code complete, never run against a project)*

Built: 5 migrations in `supabase/migrations/`, the device-local schema and repository, the outbox, the Supabase client, and `flushOutbox`. `seedHistory.ts` deleted.

- **The local database is the source of truth the UI reads.** A completed set is written locally and rendered from there; the network is a background concern the interface never waits on. Without `.env` the app runs fully offline and the outbox simply never drains — a supported state, not a broken one.
- **Repository queries are tested against the real SQLite engine.** `node:sqlite` and `expo-sqlite` differ in API but not engine, so adapting both to the `SqlDb` interface means the tests exercise the SQL that ships, with no mock and no device.
- **The outbox coalesces.** A partial unique index keeps at most one pending upsert per entity, so editing a set five times before the network returns leaves one row with the final value. The existing row keeps its original `seq`, so a parent workout never falls behind its own sets.
- **A flush stops at the first failure** rather than skipping past it. Skipping would let a set arrive before the workout that owns it and be rejected by a foreign key in a way that looks like data loss.

**Remaining for step 6 — needs a real project:**

1. `supabase link` + `supabase db push`, then seed with `data/seed/catalog.sql`. See `supabase/README.md`.
2. Add `.env` with `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
3. Auth **is** built — `src/data/auth.ts`, anonymous sign-in, upgradeable later without losing history. It has never run against a project, so `flushOutbox` still returns `skipped: no-session` here. Enable Anonymous in Authentication → Sign In / Providers.
4. `npm run check:migrations` validates syntax only. A push against a scratch project is the real test — expect the trigger and RLS policies to need a round of fixes.

### Step 7 — Co-op *(code complete, never run against a project)*

Built for N=4 from the start: `src/domain/coop.ts` (rotation mirror, focus resolution, on-deck, haptic relevance, timer math), `useSquadSlots`, `coopChannel.ts`, `auth.ts`, `src/state/coop.ts`, `SquadRail`.

- **Four shared-value slots preallocated at mount, indexed by `color_slot`.** A member joining changes a *value*, not the component tree. This is why the DB constrains the column to 0..3.
- **One frame callback maintains `nowMs`; every pod derives its own countdown from it.** One writer, N readers — timer cost is flat in squad size, nothing polls, no packets beyond the single `rest_ends_at`.
- **`hapticFor` is O(1) in squad size.** Only your own events, one tick when the person immediately before you finishes, one squad pulse per round. There is a test asserting N=2 and N=4 fire identically.
- **`resolveFocus` returns exactly one emphasis**, priority-ordered. Two things pulsing at once is the failure Zen Mode exists to prevent, and the only reliable fix is making it one resolved value rather than independent conditions in the view.
- **Auth defaults to anonymous sign-in.** A gym app should not demand an email before someone logs a set, and upgrading later keeps the same `auth.users` row and therefore all history. Enable it in Authentication → Sign In / Providers → Anonymous.

**Remaining for step 7 — needs a live project:**

1. Enable anonymous sign-in, then apply the migrations (`supabase/README.md`).
2. Turn rotation is wired: completing a set starts your rest and calls `advance_turn`. **Never executed** — the CAS path, the stale-cursor reconcile, and the round-boundary pulse all need two real devices.
3. `app/squad.tsx` creates and joins sessions (code + QR), but the QR is only *rendered* — nothing scans it. Deep links (`shift://squad/<code>`) need an `expo-linking` handler in the router.
4. Two devices, one session, then verify: the rail holds `pass` on the frame sentinel, both phones pulse together at a round boundary, and killing one phone's network for 40s makes the other skip it rather than stall.

---

### Step 8 — Sharing exercises and workouts *(domain done, UI written, never run against a project)*

Built: `src/domain/sharing.ts`, `supabase/migrations/0008_sharing.sql`, `saved_routines` locally,
`src/data/shares.ts`, `src/data/routines.ts`, `ShareSheet`, `app/routines.tsx`, the inbox in
`app/friends.tsx`, and the `shift://` deep-link handler in `app/_layout.tsx`.

- **The plan travels, the loads do not.** A weight is meaningless outside the body that lifted it, so what crosses is sets, reps and order; the receiver's own predictor fills in every number. This is also what makes the feature honest rather than a leaderboard with extra steps.
- **A received routine is adapted to the receiver's gym before they see it.** Anything their equipment cannot do is substituted through the same re-ranked similarity list Swipe-to-Swap uses, and the preview says what was replaced and why. A silent substitution would be worse than a gap.
- **Adaptation happens once, at import.** Re-adapting on open would mean a routine that rewrites itself between two sessions.
- **Two ways out: a friend, or a link.** `shift://routine/<compact>` goes through any messenger and needs no account on either side, which is the only version of this that can also be an invite.
- **Routines are device-local** and do not enter the outbox — see the comment above `saveRoutine`.

**Done since:** the migration is applied and its policies are tested — `npm run db:test` asserts all of it, including that a stranger cannot be sent a routine, that a recipient cannot rewrite what they were sent, and that a sender cannot backdate a share to the top of someone's inbox. Three holes were found this way and closed in `0008`; the reasoning is in the file.

**Remaining for step 8:**

1. Push `0008` against a *hosted* project. Local and hosted differ in extensions and defaults, so this is not the same test twice.
2. Two accounts on two devices: send, accept, and confirm the substitutions land as the preview showed.
3. On device, open a `shift://routine/…` link cold (app not running) and warm. The cold path is the one the navigation-state guard in `app/_layout.tsx` exists for.
4. A reinstall loses locally-written routines. Decide whether that is worth a `routines` sync path or whether the server copy of a *received* routine is enough.

## 6. Open decisions, not yet made

- **Media licensing.** Every record carries `© Gym visual`; the upstream repo ships a `NOTICE.md`. The 1,324 GIFs are third-party licensed and currently unhosted — the swap card shows a muscle-coded mark instead of an image. **Resolve before shipping or monetising.** Also transcode GIF → WebP/HEVC; GIF decode will fight the 8.33 ms budget.
- **Cross-equipment transfer ratios (§7.6).** Without them, a swap onto unfamiliar equipment cold-starts at the bare bar.
- **Pin the dataset.** `scripts/fetch-dataset.ts` tracks `main`. The muscle map and rules are audited against today's snapshot; upstream edits would change swap suggestions with no diff to review.
- **Haptics Phase 2.** `expo-haptics` is JS-thread; worklet → `runOnJS` costs 1–3 frames. Decide on device whether a sync JSI module is needed now.
- **Sequence solver lookahead.** The plate solver is greedy across turns; the first configuration has no lookahead. Only worth fixing if measured transition times justify it.

---

## 7. Where to look things up

| Question | Section |
|---|---|
| Why this stack / version drift | §0 |
| Runtime boundary, state ownership | §1.1–1.3 |
| Database schema, RLS, CAS | §2 |
| Component tree | §3 |
| Worklets, 120 fps, gestures, the seven rules | §4 |
| Dataset, enrichment, similarity, diversity | §5 |
| Squad rotation, plate math, Zen Mode | §6 |
| Progression prediction | §7 |
| Risks | §8 |
| Build order | §9 |

Five claims in the architecture doc were **corrected by implementing them** — the pacing rule (§6.2), the starvation signal (§6.1), the plate solver's objective (§6.3), similarity ranking (§5.3), and a missing schema column (§2.2). Each is marked in place with the reasoning. When the document and the code disagree, **the code is right and the document has a bug** — fix it and record why, as those five did.

---

## 8. Working agreement

- **Tests before behaviour changes.** The domain has 257; add to them.
- **Look at real output.** Every significant bug so far was found by running the thing and reading what came out, not by reasoning about it. The similarity diversity failure passed all its unit tests; so did the rerank bug that undid it at runtime.
- **Comment the *why*, never the *what*.** The existing code records rejected alternatives — keep that. A comment saying a plausible approach was tried and why it failed saves the next person the same afternoon.
- **`npm run verify` before saying done.**
