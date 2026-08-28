import type { RealtimeChannel } from '@supabase/supabase-js';

import type { SquadEvent } from '../domain/coop.ts';
import { getSupabase } from './supabase.ts';

/**
 * Realtime transport for a Sync Session.
 *
 * Broadcast and Presence only. **Postgres Changes is not used for anything the
 * user sees move**: WAL replication plus per-row RLS evaluation adds latency and
 * scales badly, whereas Broadcast fans out in tens of milliseconds. The database
 * remains the ledger; this is the wire (§2.5).
 *
 * Payloads carry ids and numbers, never objects, and stay small. Four clients
 * each deserialising a fat payload mid-gesture is the JS-thread starvation risk
 * that §4.7 exists to prevent — the transport is cheap, the parsing is not.
 */

export interface PresencePayload {
  user_id: string;
  color_slot: number;
  joined_at: string;
  last_seen_at: string;
}

export interface ProgressPayload {
  slot: number;
  progress: number;
  state: string;
  set_index: number;
}

export interface TurnPayload {
  cursor: number;
  active_slot: number;
  turn_started_at: string;
  loaded_kg: number | null;
}

export interface RestPayload {
  slot: number;
  /** Server time. Never a duration — see §2.5 on why ticks are never broadcast. */
  rest_ends_at: string;
  rest_target_s: number;
}

export interface CoopHandlers {
  onPresence: (members: PresencePayload[]) => void;
  onProgress: (payload: ProgressPayload) => void;
  onTurn: (payload: TurnPayload) => void;
  onRest: (payload: RestPayload) => void;
  onEvent: (event: SquadEvent) => void;
  onStatus: (status: 'joined' | 'closed' | 'error') => void;
}

export interface CoopChannel {
  broadcastProgress: (payload: ProgressPayload) => void;
  broadcastRest: (payload: RestPayload) => void;
  broadcastEvent: (event: SquadEvent) => void;
  heartbeat: () => void;
  leave: () => Promise<void>;
}

/** Presence keys change at most once a second; progress goes over Broadcast. */
const HEARTBEAT_MS = 5_000;

export function joinSession(
  sessionId: string,
  userId: string,
  colorSlot: number,
  handlers: CoopHandlers,
): CoopChannel | null {
  const supabase = getSupabase();
  if (!supabase) return null;

  const channel: RealtimeChannel = supabase.channel(`sync:${sessionId}`, {
    config: { presence: { key: userId }, broadcast: { self: false } },
  });

  let lastCursor = -1;

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresencePayload>();
      const members = Object.values(state).flatMap((entries) => entries);
      handlers.onPresence(members);
    })
    .on('broadcast', { event: 'progress' }, ({ payload }) => {
      handlers.onProgress(payload as ProgressPayload);
    })
    .on('broadcast', { event: 'turn' }, ({ payload }) => {
      const turn = payload as TurnPayload;
      // `turn_cursor` doubles as the ordering token: a message older than what
      // we already hold is discarded, which makes out-of-order delivery a
      // non-issue with no client-side sequencing logic.
      if (turn.cursor <= lastCursor) return;
      lastCursor = turn.cursor;
      handlers.onTurn(turn);
    })
    .on('broadcast', { event: 'rest' }, ({ payload }) => {
      handlers.onRest(payload as RestPayload);
    })
    .on('broadcast', { event: 'squad' }, ({ payload }) => {
      handlers.onEvent(payload as SquadEvent);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        void channel.track({
          user_id: userId,
          color_slot: colorSlot,
          joined_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        });
        handlers.onStatus('joined');
      } else if (status === 'CLOSED') {
        handlers.onStatus('closed');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        handlers.onStatus('error');
      }
    });

  const timer = setInterval(() => {
    void channel.track({
      user_id: userId,
      color_slot: colorSlot,
      joined_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
  }, HEARTBEAT_MS);

  const send = (event: string, payload: unknown) => {
    void channel.send({ type: 'broadcast', event, payload });
  };

  return {
    broadcastProgress: (payload) => send('progress', payload),
    broadcastRest: (payload) => send('rest', payload),
    broadcastEvent: (event) => send('squad', event),
    heartbeat: () => {
      void channel.track({
        user_id: userId,
        color_slot: colorSlot,
        joined_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
    },
    leave: async () => {
      clearInterval(timer);
      await supabase.removeChannel(channel);
    },
  };
}

/**
 * Advance the station's turn.
 *
 * A `stale_cursor` failure (SQLSTATE 40001) means another member got there
 * first. The caller refetches and reconciles — it must never retry blindly, or
 * four clients racing at a round boundary turn into a retry storm.
 */
export async function advanceTurn(
  stationId: string,
  expectedCursor: number,
): Promise<{ ok: true } | { ok: false; stale: boolean; error: string }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, stale: false, error: 'not-configured' };

  const { error } = await supabase.rpc('advance_turn', {
    p_station: stationId,
    p_expected_cursor: expectedCursor,
  });

  if (!error) return { ok: true };
  return { ok: false, stale: error.code === '40001', error: error.message };
}
