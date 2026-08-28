import { getSupabase } from './supabase.ts';

/**
 * Stations: the unit of rotation.
 *
 * A squad of four rarely queues on one bar — they split two and two. So turn
 * state belongs to a station, not to the session, and a session can hold
 * several.
 */

export interface StationState {
  id: string;
  sessionId: string;
  exerciseId: string;
  turnCursor: number;
  activeUserId: string | null;
  turnStartedAt: string | null;
  turnDeadlineAt: string | null;
  roundIndex: number;
  direction: 1 | -1;
  loadedKg: number | null;
  planVersion: number;
}

interface StationRow {
  id: string;
  session_id: string;
  exercise_id: string;
  turn_cursor: number;
  active_user_id: string | null;
  turn_started_at: string | null;
  turn_deadline_at: string | null;
  round_index: number;
  direction: number;
  loaded_kg: number | null;
  plan_version: number;
}

function toState(row: StationRow): StationState {
  return {
    id: row.id,
    sessionId: row.session_id,
    exerciseId: row.exercise_id,
    turnCursor: row.turn_cursor,
    activeUserId: row.active_user_id,
    turnStartedAt: row.turn_started_at,
    turnDeadlineAt: row.turn_deadline_at,
    roundIndex: row.round_index,
    direction: row.direction >= 0 ? 1 : -1,
    loadedKg: row.loaded_kg,
    planVersion: row.plan_version,
  };
}

export async function openStation(
  sessionId: string,
  exerciseId: string,
  orderIndex = 0,
): Promise<StationState | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('sync_stations')
    .upsert(
      { session_id: sessionId, exercise_id: exerciseId, order_index: orderIndex },
      { onConflict: 'session_id,order_index' },
    )
    .select('*')
    .single();

  return error ? null : toState(data as StationRow);
}

export async function fetchStation(stationId: string): Promise<StationState | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('sync_stations')
    .select('*')
    .eq('id', stationId)
    .maybeSingle();

  return error || !data ? null : toState(data as StationRow);
}

/** Assign queue positions from the members' planned loads. */
export async function seatMembers(
  stationId: string,
  ordered: readonly { userId: string; plannedLoadKg: number }[],
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  // Ascending by load: every changeover then only adds plates, which is optimal
  // within a round regardless of pacing strategy (§6.2).
  const byLoad = [...ordered].sort((a, b) => a.plannedLoadKg - b.plannedLoadKg);

  await Promise.all(
    byLoad.map((member, index) =>
      supabase
        .from('sync_members')
        .update({ station_id: stationId, queue_pos: index, planned_load_kg: member.plannedLoadKg })
        .eq('user_id', member.userId),
    ),
  );
}

export type AdvanceResult =
  | { ok: true; station: StationState }
  | { ok: false; stale: true; station: StationState | null }
  | { ok: false; stale: false; error: string };

/**
 * Hand the bar to the next lifter.
 *
 * The database function is a compare-and-swap on `turn_cursor`. Two clients
 * racing on "I'm done" is survivable; four colliding at a round boundary is not,
 * and the loser must **refetch rather than retry** — a blind retry from four
 * phones is a storm, not a resolution.
 */
export async function advanceTurn(
  stationId: string,
  expectedCursor: number,
): Promise<AdvanceResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, stale: false, error: 'not-configured' };

  const { data, error } = await supabase.rpc('advance_turn', {
    p_station: stationId,
    p_expected_cursor: expectedCursor,
  });

  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as StationRow | undefined;
    return row
      ? { ok: true, station: toState(row) }
      : { ok: false, stale: false, error: 'empty response' };
  }

  if (error.code === '40001' || error.message.includes('stale_cursor')) {
    return { ok: false, stale: true, station: await fetchStation(stationId) };
  }

  return { ok: false, stale: false, error: error.message };
}

/** Start this member's rest and publish the end time the squad counts down to. */
export async function startRest(
  sessionId: string,
  userId: string,
  restTargetS: number,
): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  // Computed from the server clock, never the device's. Every phone then counts
  // down locally against this one timestamp (§2.5).
  const { data: serverNow } = await supabase.rpc('server_now');
  const base = serverNow ? Date.parse(String(serverNow)) : Date.now();
  const endsAt = new Date(base + restTargetS * 1000).toISOString();

  await supabase
    .from('sync_members')
    .update({ rest_ends_at: endsAt, rest_target_s: restTargetS, state: 'resting' })
    .eq('session_id', sessionId)
    .eq('user_id', userId);

  return endsAt;
}

export async function setMemberState(
  sessionId: string,
  userId: string,
  state: 'idle' | 'working' | 'resting' | 'ready',
  currentSetIndex?: number,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  await supabase
    .from('sync_members')
    .update({
      state,
      last_seen_at: new Date().toISOString(),
      ...(currentSetIndex === undefined ? {} : { current_set_index: currentSetIndex }),
    })
    .eq('session_id', sessionId)
    .eq('user_id', userId);
}
