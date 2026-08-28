# Shift — Supabase

Migrations for the Shift backend, in Supabase CLI layout.

## Applying them

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

`supabase db push` runs `migrations/*.sql` in filename order. It asks for the
database password itself — **nothing in this repository stores or needs a
service-role key or a database password.**

If you would rather not use the CLI, paste each file into the SQL editor in the
Supabase dashboard, in numeric order.

## Seeding the catalog

After the migrations, load the 1,324 exercises and the similarity matrix:

```bash
psql "$SUPABASE_DB_URL" -f ../data/seed/catalog.sql
```

Or paste `data/seed/catalog.sql` into the SQL editor. Regenerate it any time with
`npm run catalog`; it truncates and reloads, so it is safe to re-run.

## Configuring the app

Create `.env` in the project root:

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

Both come from **Project Settings → API**. The anon key is public by design — it
ships inside the app binary and is only useful in combination with row level
security, which every table has (`0005_rls.sql`). The service-role key belongs
nowhere near this project.

Without `.env` the app runs fully offline: workouts are logged to the local
SQLite database and the outbox simply never drains. That is a supported state,
not a broken one.

## What each migration does

| File | Contents |
|---|---|
| `0001_catalog.sql` | `exercises`, `exercise_similarity`. Public reference data, read-only to clients. |
| `0002_user.sql` | `profiles`, routines, `workouts`, `sets` (with the generated `e1rm` column), `exercise_progression`, `personal_records`. |
| `0003_coop.sql` | Sync Session: sessions, stations, members, turn plan, event log. |
| `0004_functions.sql` | `is_session_member`, `refresh_progression` trigger, `next_in_rotation`, `advance_turn` (compare-and-swap), `server_now`. |
| `0005_rls.sql` | Row level security for every table. |
| `0006_friends.sql` | Handles, `friendships`, `friend_stats`, `record_events`, `user_reports`, the `avatars` bucket, and the `are_friends` / `is_blocked_with` helpers. |
| `0007_discovery.sql` | Trigram search over handle and display name; `discoverable` becomes the single control over being found, photo included. |
| `0008_sharing.sql` | `shared_routines` — sending a routine to a friend. Adds `routine_exercises.target_reps`. |

## Verification

```bash
npm run check:migrations
```

Parses every file with libpg_query — the real PostgreSQL grammar, compiled to
WebAssembly — so syntax errors are caught on any machine with no database and no
Docker. It validates **syntax, not semantics**: a wrong column name still gets
through, so a real `db push` against a scratch project is still the last word.

## Things to know before pushing

- `advance_turn()` raises `stale_cursor` (SQLSTATE 40001) when two clients race.
  Clients must refetch and reconcile, never retry blindly.
- `refresh_progression()` mirrors `src/domain/progression.ts`. Epley's 12-rep cap
  and the definition of a failed session are the two places they could silently
  diverge — change them together.
- `shared_routines.payload` is jsonb on purpose. A sent routine is a message,
  not a live view of the sender's data — theirs can change or be deleted and
  what you received does not move. The insert policy is where "only friends can
  send you things" is actually enforced; the client check is a courtesy.
- The partial unique index on `shared_routines` uses `md5(payload::text)`. Both
  the cast and md5 are immutable, so it is a legal index expression — but this
  is exactly the sort of thing `check:migrations` cannot prove. Watch for it on
  the first push.
- Realtime should carry ids and numbers, never objects. Four clients
  deserialising a fat payload mid-gesture is the JS-thread starvation risk in
  §4.7 of the architecture doc.
