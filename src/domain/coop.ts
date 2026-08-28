import type { MemberState } from './types.ts';

/**
 * Squad logic for the Sync Session — pure, deterministic, and worklet-safe
 * where it needs to be.
 *
 * Everything a squad of 2–4 does that is *decidable* lives here: who lifts next,
 * what the screen should be emphasising, how long until your turn, and which
 * events are allowed to buzz your phone. The Realtime transport and the render
 * tree are thin layers over this.
 */

export interface SquadMember {
  userId: string;
  displayName: string;
  /** 0..3. Preallocated shared-value slots are indexed by this (§4.7). */
  colorSlot: 0 | 1 | 2 | 3;
  queuePos: number;
  state: MemberState;
  currentSetIndex: number;
  targetSets: number;
  plannedLoadKg: number | null;
  /** Fraction of that member's own best e1RM. The rail's display metric (§6.3). */
  relativeIntensity: number | null;
  /** ISO 8601, server time. Per member — there is no session-level timer. */
  restEndsAt: string | null;
  restTargetS: number;
  avgWorkS: number;
  lastSeenAt: string;
}

export interface SquadSnapshot {
  sessionId: string;
  selfId: string;
  members: SquadMember[];
  activeUserId: string | null;
  turnStartedAt: string | null;
  /** What is physically on the bar right now. */
  loadedKg: number | null;
  direction: 1 | -1;
}

/** Seconds of changeover between turns when no measured plan is available. */
export const DEFAULT_TRANSITION_S = 12;

export const AWAY_AFTER_MS = 15_000;
export const STALLED_AFTER_MS = 30_000;

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export function isInactive(state: MemberState): boolean {
  return state === 'away' || state === 'stalled';
}

/**
 * The members the squad rail renders.
 *
 * **You are never in the rail.** You are the main card; the rail shows the other
 * one to three people. That single decision caps the rail at three elements and
 * removes most of the clutter problem before any visual design starts (§6.4).
 */
export function railMembers(snapshot: SquadSnapshot): SquadMember[] {
  return snapshot.members
    .filter((m) => m.userId !== snapshot.selfId)
    .sort((a, b) => a.queuePos - b.queuePos);
}

export function self(snapshot: SquadSnapshot): SquadMember | null {
  return snapshot.members.find((m) => m.userId === snapshot.selfId) ?? null;
}

/**
 * Liveness from a heartbeat, in three stages.
 *
 * Someone always drops in a gym. `stalled` is what lets the rotation skip them
 * so a squad of four is never blocked on one phone.
 */
export function liveness(member: SquadMember, nowMs: number): 'live' | 'away' | 'stalled' {
  const silentFor = nowMs - Date.parse(member.lastSeenAt);
  if (silentFor >= STALLED_AFTER_MS) return 'stalled';
  if (silentFor >= AWAY_AFTER_MS) return 'away';
  return 'live';
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Client mirror of the SQL `next_in_rotation()`.
 *
 * Exists so the UI can predict the next lifter without waiting for a round trip.
 * The server stays authoritative through `advance_turn()`; if the two disagree,
 * the server wins and the client reconciles. Keeping them in step matters — a
 * rail that names the wrong person is worse than one that lags.
 */
export function nextInRotation(
  members: readonly SquadMember[],
  activeUserId: string | null,
  direction: 1 | -1,
): string | null {
  const eligible = members
    .filter((m) => !isInactive(m.state))
    .sort((a, b) => a.queuePos - b.queuePos);

  if (eligible.length === 0) return null;
  if (activeUserId === null) {
    return (direction >= 0 ? eligible[0] : eligible[eligible.length - 1])!.userId;
  }

  const active = members.find((m) => m.userId === activeUserId);
  if (!active) return eligible[0]!.userId;

  const ahead =
    direction >= 0
      ? eligible.filter((m) => m.queuePos > active.queuePos)
      : eligible.filter((m) => m.queuePos < active.queuePos).reverse();

  if (ahead.length > 0) return ahead[0]!.userId;

  // Round boundary: wrap to whichever end the direction implies.
  return (direction >= 0 ? eligible[0] : eligible[eligible.length - 1])!.userId;
}

/** Turns between the active lifter and `userId`, following the rotation. */
export function turnsUntil(
  members: readonly SquadMember[],
  activeUserId: string | null,
  direction: 1 | -1,
  userId: string,
): number | null {
  const eligible = members.filter((m) => !isInactive(m.state));
  if (!eligible.some((m) => m.userId === userId)) return null;
  if (activeUserId === userId) return 0;

  let cursor = activeUserId;
  for (let i = 1; i <= eligible.length; i++) {
    cursor = nextInRotation(members, cursor, direction);
    if (cursor === null) return null;
    if (cursor === userId) return i;
  }
  return null;
}

export interface OnDeck {
  /** Turns away. 0 means it is your turn now. */
  turnsAway: number;
  etaS: number;
  /** What the bar has to change to, or null when nothing moves. */
  loadFromKg: number | null;
  loadToKg: number | null;
}

/**
 * "You're up in ~40s, bar 100 → 80."
 *
 * At N=4 this one line is worth more than every other member's full state, so it
 * gets its own computation rather than being derived in the view. ETA sums the
 * remaining work of everyone between the active lifter and you.
 */
export function onDeck(
  snapshot: SquadSnapshot,
  transitionS = DEFAULT_TRANSITION_S,
): OnDeck | null {
  const me = self(snapshot);
  if (!me || isInactive(me.state)) return null;

  const turnsAway = turnsUntil(
    snapshot.members,
    snapshot.activeUserId,
    snapshot.direction,
    me.userId,
  );
  if (turnsAway === null) return null;

  let etaS = 0;
  let cursor = snapshot.activeUserId;
  for (let i = 0; i < turnsAway; i++) {
    const member = snapshot.members.find((m) => m.userId === cursor);
    etaS += (member?.avgWorkS ?? DEFAULT_TRANSITION_S) + transitionS;
    cursor = nextInRotation(snapshot.members, cursor, snapshot.direction);
  }

  return {
    turnsAway,
    etaS: Math.round(etaS),
    loadFromKg: snapshot.loadedKg,
    loadToKg: me.plannedLoadKg,
  };
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export type FocusKind =
  | 'self-rest-ending'
  | 'self-on-deck'
  | 'self-working'
  | 'member-working'
  | 'idle';

export interface Focus {
  kind: FocusKind;
  /** The member the screen should emphasise, if any. */
  userId: string | null;
}

/** Below this, your own countdown takes the screen. */
export const REST_ENDING_S = 5;

/**
 * Exactly one thing is emphasised at a time.
 *
 * Priority order, first match wins. Two things pulsing at once is the failure
 * mode Zen Mode exists to prevent, and the only reliable way to avoid it is to
 * make "what is emphasised" a single resolved value rather than a set of
 * independent conditions in the view (§6.4).
 */
export function resolveFocus(snapshot: SquadSnapshot, nowMs: number): Focus {
  const me = self(snapshot);

  if (me?.restEndsAt) {
    const remaining = (Date.parse(me.restEndsAt) - nowMs) / 1000;
    if (remaining > 0 && remaining <= REST_ENDING_S) {
      return { kind: 'self-rest-ending', userId: me.userId };
    }
  }

  if (snapshot.activeUserId === snapshot.selfId) {
    return { kind: 'self-working', userId: snapshot.selfId };
  }

  if (me && !isInactive(me.state)) {
    const turns = turnsUntil(snapshot.members, snapshot.activeUserId, snapshot.direction, me.userId);
    if (turns === 1) return { kind: 'self-on-deck', userId: me.userId };
  }

  if (snapshot.activeUserId !== null) {
    return { kind: 'member-working', userId: snapshot.activeUserId };
  }

  return { kind: 'idle', userId: null };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Below this width a pod shows only its ring; above it, the label fades in. */
export const POD_COMPACT_W = 74;
export const POD_WIDE_W = 150;

/**
 * Pod width as a continuous function of squad size.
 *
 * Deliberately not a breakpoint: a member joining animates every pod's width
 * rather than snapping the layout to a different branch, and the label fades in
 * by interpolating this value instead of being conditionally rendered (§6.4).
 */
export function podWidth(railWidth: number, memberCount: number, gap = 8): number {
  const pods = Math.max(memberCount - 1, 1); // you are never in the rail
  if (railWidth <= 0) return 0;
  return Math.max(0, (railWidth - gap * (pods - 1)) / pods);
}

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------

export type SquadEvent =
  | { type: 'rest_ended'; userId: string }
  | { type: 'turn_started'; userId: string }
  | { type: 'set_completed'; userId: string }
  | { type: 'personal_record'; userId: string }
  | { type: 'round_completed' };

export type SquadHaptic = 'tick' | 'press' | 'commit' | 'warn' | 'celebrate';

/**
 * Which squad events are allowed to reach the Taptic Engine.
 *
 * The naive implementation fires on everything, so a squad of four buzzes four
 * times as often and the user switches haptics off — removing a core pillar of
 * the product. Only three things get through: events about you, the single tick
 * telling you the person before you just finished, and one squad-wide pulse at
 * the end of a round.
 *
 * The result is **O(1) in squad size**: identical haptic load at N=4 and N=2.
 */
export function hapticFor(
  event: SquadEvent,
  snapshot: SquadSnapshot,
): SquadHaptic | null {
  if (event.type === 'round_completed') return 'commit';

  if (event.userId === snapshot.selfId) {
    switch (event.type) {
      case 'rest_ended':
        return 'commit';
      case 'turn_started':
        return 'commit';
      case 'personal_record':
        return 'celebrate';
      case 'set_completed':
        return null; // your own tap already produced feedback
    }
  }

  // The only thing another member's activity may trigger: your on-deck cue.
  if (event.type === 'set_completed') {
    const me = self(snapshot);
    if (!me || isInactive(me.state)) return null;
    const theirTurns = turnsUntil(
      snapshot.members,
      snapshot.activeUserId,
      snapshot.direction,
      me.userId,
    );
    if (theirTurns === 1 && event.userId === snapshot.activeUserId) return 'tick';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/**
 * Seconds left on a rest timer, measured against server-aligned time.
 *
 * `clockOffsetMs` comes from the join-time RPC sampling (§2.5). Every countdown
 * on screen — yours and every squadmate's — is computed from timestamps already
 * held locally, so one frame callback drives them all and the cost is flat in
 * squad size. Nothing is polled and no further packets are exchanged.
 */
export function restRemainingS(
  restEndsAt: string | null,
  nowMs: number,
  clockOffsetMs: number,
): number {
  'worklet';
  if (restEndsAt === null) return 0;
  return Math.max(0, (Date.parse(restEndsAt) - (nowMs + clockOffsetMs)) / 1000);
}

/** Fraction elapsed, for a progress ring. 0 at the start of rest, 1 at the end. */
export function restProgress(
  restEndsAt: string | null,
  restTargetS: number,
  nowMs: number,
  clockOffsetMs: number,
): number {
  'worklet';
  if (restEndsAt === null || restTargetS <= 0) return 1;
  const remaining = restRemainingS(restEndsAt, nowMs, clockOffsetMs);
  return Math.min(1, Math.max(0, 1 - remaining / restTargetS));
}

/**
 * Best clock offset from a set of round-trip samples.
 *
 * Keeps the lowest-RTT sample rather than averaging: a single delayed packet
 * skews a mean badly, while the fastest round trip is the one least distorted by
 * queueing. Assumes symmetric latency, which is close enough to fire a
 * squad-wide haptic in unison.
 */
export function bestOffset(
  samples: readonly { sentMs: number; serverMs: number; receivedMs: number }[],
): number {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };
  for (const s of samples) {
    const rtt = s.receivedMs - s.sentMs;
    if (rtt < 0) continue;
    const offset = s.serverMs - (s.sentMs + rtt / 2);
    if (rtt < best.rtt) best = { rtt, offset };
  }
  return Number.isFinite(best.rtt) ? Math.round(best.offset) : 0;
}
