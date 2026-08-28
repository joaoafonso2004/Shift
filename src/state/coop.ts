import { create } from 'zustand';

import {
  hapticFor,
  nextInRotation,
  onDeck,
  railMembers,
  resolveFocus,
  type OnDeck,
  type Focus,
  type SquadEvent,
  type SquadMember,
  type SquadSnapshot,
} from '../domain/coop.ts';
import { joinSession, type CoopChannel } from '../data/coopChannel.ts';
import { measureClockOffset } from '../data/supabase.ts';
import { ensureIdentity } from '../data/auth.ts';
import {
  advanceTurn,
  openStation,
  seatMembers,
  setMemberState,
  startRest,
  type StationState,
} from '../data/station.ts';

/**
 * Sync Session state.
 *
 * Holds *facts* — who is in the squad, whose turn it is, when each rest ends.
 * The values that change at frame rate live in shared values (`useSquadSlots`),
 * written directly from the Realtime ingress path. This store is what the rest
 * of the app queries; it is not what the rail animates from.
 */

export type CoopStatus = 'off' | 'connecting' | 'live' | 'error';

interface CoopState {
  status: CoopStatus;
  sessionId: string | null;
  selfId: string | null;
  members: SquadMember[];
  activeUserId: string | null;
  direction: 1 | -1;
  loadedKg: number | null;
  clockOffsetMs: number;
  channel: CoopChannel | null;
  station: StationState | null;
  /** Set by the UI so ingress can fire the right haptic without a re-render. */
  onHaptic: ((kind: ReturnType<typeof hapticFor>) => void) | null;

  join: (sessionId: string) => Promise<void>;
  leave: () => Promise<void>;
  openStationFor: (exerciseId: string, seats: readonly { userId: string; plannedLoadKg: number }[]) => Promise<void>;
  finishTurn: (restTargetS: number) => Promise<void>;
  isMyTurn: () => boolean;
  setHapticSink: (sink: CoopState['onHaptic']) => void;
  applyEvent: (event: SquadEvent) => void;
  snapshot: () => SquadSnapshot | null;
  focus: (nowMs: number) => Focus | null;
  deck: () => OnDeck | null;
  rail: () => SquadMember[];
  predictedNext: () => string | null;
}

export const useCoop = create<CoopState>((set, get) => ({
  status: 'off',
  sessionId: null,
  selfId: null,
  members: [],
  activeUserId: null,
  direction: 1,
  loadedKg: null,
  clockOffsetMs: 0,
  channel: null,
  station: null,
  onHaptic: null,

  join: async (sessionId) => {
    set({ status: 'connecting' });

    const identity = await ensureIdentity();
    if (!identity) {
      set({ status: 'error' });
      return;
    }

    // Measured once on join. Every countdown afterwards is computed locally
    // against this, so devices stay aligned without exchanging another packet.
    const clockOffsetMs = await measureClockOffset();

    const channel = joinSession(sessionId, identity.userId, 0, {
      onPresence: (presence) => {
        set((state) => ({
          members: state.members.map((m) => {
            const seen = presence.find((p) => p.user_id === m.userId);
            return seen ? { ...m, lastSeenAt: seen.last_seen_at } : m;
          }),
        }));
      },
      onProgress: (payload) => {
        set((state) => ({
          members: state.members.map((m) =>
            m.colorSlot === payload.slot
              ? { ...m, currentSetIndex: payload.set_index, state: payload.state as SquadMember['state'] }
              : m,
          ),
        }));
      },
      onTurn: (payload) => {
        const member = get().members.find((m) => m.colorSlot === payload.active_slot);
        const station = get().station;
        set({
          activeUserId: member?.userId ?? null,
          loadedKg: payload.loaded_kg,
          // Carry the cursor forward so the next local advance compares against
          // what the server actually holds.
          station: station ? { ...station, turnCursor: payload.cursor } : station,
        });
        if (member?.userId === get().selfId) {
          get().applyEvent({ type: 'turn_started', userId: member.userId });
        }
      },
      onRest: (payload) => {
        set((state) => ({
          members: state.members.map((m) =>
            m.colorSlot === payload.slot
              ? { ...m, restEndsAt: payload.rest_ends_at, restTargetS: payload.rest_target_s }
              : m,
          ),
        }));
      },
      onEvent: (event) => get().applyEvent(event),
      onStatus: (status) => {
        set({ status: status === 'joined' ? 'live' : status === 'error' ? 'error' : 'off' });
      },
    });

    set({
      sessionId,
      selfId: identity.userId,
      clockOffsetMs,
      channel,
      status: channel ? 'connecting' : 'error',
    });
  },

  leave: async () => {
    const { sessionId, selfId } = get();
    if (sessionId && selfId) await setMemberState(sessionId, selfId, 'idle');
    await get().channel?.leave();
    set({
      status: 'off',
      sessionId: null,
      members: [],
      activeUserId: null,
      channel: null,
      station: null,
      loadedKg: null,
    });
  },

  /**
   * Put the squad on one exercise and seat them by planned load.
   *
   * Ascending order means every changeover only adds plates, which is optimal
   * within a round whatever pacing strategy the planner picks (§6.2).
   */
  openStationFor: async (exerciseId, seats) => {
    const { sessionId } = get();
    if (!sessionId) return;

    const station = await openStation(sessionId, exerciseId);
    if (!station) return;

    await seatMembers(station.id, seats);
    set({ station, activeUserId: station.activeUserId, loadedKg: station.loadedKg });
  },

  /**
   * Finish your turn: start your rest, then hand the bar on.
   *
   * Rest is started *before* advancing so your countdown begins at the moment
   * you actually stopped lifting, not after a network round trip. The two are
   * independent facts and coupling them would make a slow connection shorten
   * your rest.
   */
  finishTurn: async (restTargetS) => {
    const { sessionId, selfId, station, channel, members } = get();
    if (!sessionId || !selfId) return;

    const me = members.find((m) => m.userId === selfId);
    const endsAt = await startRest(sessionId, selfId, restTargetS);

    if (endsAt) {
      set({
        members: get().members.map((m) =>
          m.userId === selfId ? { ...m, restEndsAt: endsAt, restTargetS, state: 'resting' } : m,
        ),
      });
      // One message carrying an end timestamp. Ticks are never broadcast — every
      // phone counts down locally against this (§2.5).
      channel?.broadcastRest({
        slot: me?.colorSlot ?? 0,
        rest_ends_at: endsAt,
        rest_target_s: restTargetS,
      });
    }

    if (!station) return;

    const result = await advanceTurn(station.id, station.turnCursor);

    if (result.ok) {
      set({
        station: result.station,
        activeUserId: result.station.activeUserId,
        loadedKg: result.station.loadedKg,
      });
      channel?.broadcastEvent({ type: 'set_completed', userId: selfId });
      if (result.station.roundIndex > station.roundIndex) {
        channel?.broadcastEvent({ type: 'round_completed' });
      }
    } else if (result.stale && result.station) {
      // Somebody else advanced first. Reconcile to server truth rather than
      // retrying — four phones retrying blindly is a storm.
      set({
        station: result.station,
        activeUserId: result.station.activeUserId,
        loadedKg: result.station.loadedKg,
      });
    }
  },

  isMyTurn: () => {
    const { activeUserId, selfId } = get();
    return activeUserId !== null && activeUserId === selfId;
  },

  setHapticSink: (sink) => set({ onHaptic: sink }),

  // Ingress: decide once whether this event concerns the user, then fire.
  // Squad size does not multiply what reaches the Taptic Engine (§6.5).
  applyEvent: (event) => {
    const snapshot = get().snapshot();
    if (!snapshot) return;
    const kind = hapticFor(event, snapshot);
    if (kind) get().onHaptic?.(kind);
  },

  snapshot: () => {
    const { sessionId, selfId, members, activeUserId, direction, loadedKg } = get();
    if (!sessionId || !selfId) return null;
    return {
      sessionId,
      selfId,
      members,
      activeUserId,
      turnStartedAt: null,
      loadedKg,
      direction,
    };
  },

  focus: (nowMs) => {
    const snapshot = get().snapshot();
    return snapshot ? resolveFocus(snapshot, nowMs) : null;
  },

  deck: () => {
    const snapshot = get().snapshot();
    return snapshot ? onDeck(snapshot) : null;
  },

  rail: () => {
    const snapshot = get().snapshot();
    return snapshot ? railMembers(snapshot) : [];
  },

  predictedNext: () => {
    const { members, activeUserId, direction } = get();
    return nextInRotation(members, activeUserId, direction);
  },
}));
