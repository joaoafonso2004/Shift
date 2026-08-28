import type { SqlDb } from './localSchema.ts';
import { markFailed, markSynced, pending, pruneOutbox, type OutboxRow } from './repository.ts';
import { getSupabase, isSupabaseConfigured } from './supabase.ts';

/**
 * Drains the outbox into Supabase.
 *
 * Deliberately dumb: rows are applied strictly in `seq` order and the batch
 * stops at the first failure. Skipping past a failed row would let a set arrive
 * before the workout that owns it, and the foreign key would reject it in a way
 * that looks like data loss. Stopping means the queue drains next time, in
 * order, from where it left off.
 *
 * Never called from a gesture path, and its result never gates a render — the
 * UI reads the local database and does not care whether this has run.
 */

export type SyncOutcome =
  | { status: 'skipped'; reason: 'not-configured' | 'no-session' | 'empty' | 'in-flight' }
  | { status: 'done'; synced: number; pruned: number }
  | { status: 'stopped'; synced: number; error: string };

const TABLE: Record<string, string> = {
  workout: 'workouts',
  workout_exercise: 'workout_exercises',
  set: 'sets',
};

/** Local column names to their Postgres equivalents. */
function toRemote(entity: string, payload: Record<string, unknown>, userId: string) {
  switch (entity) {
    case 'workout':
      return {
        client_id: payload.id,
        user_id: userId,
        routine_id: payload.routineId ?? null,
        started_at: payload.startedAt,
        ended_at: payload.endedAt ?? null,
        status: payload.status ?? 'active',
      };
    case 'workout_exercise':
      return {
        client_id: payload.id,
        exercise_id: payload.exerciseId,
        swapped_from_exercise_id: payload.swappedFromExerciseId ?? null,
        order_index: payload.orderIndex,
      };
    case 'set':
      return {
        user_id: userId,
        exercise_id: payload.exerciseId,
        set_index: payload.setIndex,
        weight_kg: payload.weightKg,
        reps: payload.reps,
        rpe: payload.rpe ?? null,
        is_warmup: payload.isWarmup ?? false,
        completed_at: payload.completedAt,
        client_seq: payload.clientSeq,
      };
    default:
      return payload;
  }
}

let inFlight = false;

export async function flushOutbox(db: SqlDb, batchSize = 100): Promise<SyncOutcome> {
  if (!isSupabaseConfigured()) return { status: 'skipped', reason: 'not-configured' };
  if (inFlight) return { status: 'skipped', reason: 'in-flight' };

  const supabase = getSupabase()!;
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return { status: 'skipped', reason: 'no-session' };

  const rows = pending(db, batchSize);
  if (rows.length === 0) return { status: 'skipped', reason: 'empty' };

  inFlight = true;
  const done: number[] = [];

  try {
    for (const row of rows) {
      const error = await applyRow(supabase, row, userId);
      if (error) {
        markFailed(db, row.seq, error);
        if (done.length > 0) markSynced(db, done, new Date().toISOString());
        return { status: 'stopped', synced: done.length, error };
      }
      done.push(row.seq);
    }

    const now = new Date().toISOString();
    markSynced(db, done, now);
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return { status: 'done', synced: done.length, pruned: pruneOutbox(db, cutoff) };
  } finally {
    inFlight = false;
  }
}

async function applyRow(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  row: OutboxRow,
  userId: string,
): Promise<string | null> {
  const table = TABLE[row.entity];
  if (!table) return `unknown entity "${row.entity}"`;

  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  if (row.op === 'delete') {
    const { error } = await supabase.from(table).delete().eq('client_id', payload.id);
    return error ? error.message : null;
  }

  const { error } = await supabase
    .from(table)
    // The device generates the idempotency key before anything reaches the
    // network, so replaying a batch after a failed flush updates rather than
    // duplicating.
    .upsert(toRemote(row.entity, payload, userId), { onConflict: 'client_id' });

  return error ? error.message : null;
}
