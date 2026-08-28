/**
 * Friendships.
 *
 * Deliberately separate from the Sync Session. A squad is *ephemeral* — a
 * six-character code, four people in one room, expired six hours later. A
 * friendship is *permanent*. Coupling them would mean you had to add someone as
 * a friend before you could train with them, which is exactly the friction the
 * join code exists to remove.
 */

export type FriendshipState = 'pending' | 'accepted' | 'blocked';

/** How a friendship looks from one particular person's side. */
export type Relation =
  | 'none'
  | 'outgoing'
  | 'incoming'
  | 'friends'
  | 'blocked-by-me'
  | 'blocked-me';

export interface Friendship {
  /** Always the lexicographically smaller id. */
  userA: string;
  /** Always the larger. */
  userB: string;
  state: FriendshipState;
  /** Who sent the request, or who applied the block. */
  actorId: string;
  createdAt: string;
  respondedAt: string | null;
}

/**
 * Order a pair canonically.
 *
 * One row per relationship, never two. Storing a row per direction means every
 * accept, block and unfriend has to update both — and the first time one write
 * lands and the other does not, you get a friendship that exists for one person
 * and not the other. Direction is preserved separately in `actorId`.
 */
export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function sameUser(a: string, b: string): boolean {
  return a === b;
}

/** What a friendship means to the person looking at it. */
export function relationFor(
  friendship: Friendship | null,
  viewerId: string,
): Relation {
  if (!friendship) return 'none';

  if (friendship.state === 'blocked') {
    return friendship.actorId === viewerId ? 'blocked-by-me' : 'blocked-me';
  }

  if (friendship.state === 'accepted') return 'friends';

  return friendship.actorId === viewerId ? 'outgoing' : 'incoming';
}

export type RequestOutcome =
  | { ok: true; action: 'create'; friendship: Friendship }
  | { ok: true; action: 'auto-accept'; friendship: Friendship }
  | { ok: false; reason: 'self' | 'already-friends' | 'already-sent' | 'blocked' };

/**
 * Send a friend request.
 *
 * The case worth handling carefully: two people request each other before
 * either has responded. Leaving both requests pending means each sees an
 * invitation from someone they already invited, and neither knows who should
 * act. Crossing requests are treated as mutual consent and accepted outright.
 */
export function requestFriendship(
  existing: Friendship | null,
  requesterId: string,
  addresseeId: string,
  now: string,
): RequestOutcome {
  if (sameUser(requesterId, addresseeId)) return { ok: false, reason: 'self' };

  const [userA, userB] = canonicalPair(requesterId, addresseeId);

  if (existing) {
    if (existing.state === 'blocked') return { ok: false, reason: 'blocked' };
    if (existing.state === 'accepted') return { ok: false, reason: 'already-friends' };
    if (existing.actorId === requesterId) return { ok: false, reason: 'already-sent' };

    return {
      ok: true,
      action: 'auto-accept',
      friendship: { ...existing, state: 'accepted', respondedAt: now },
    };
  }

  return {
    ok: true,
    action: 'create',
    friendship: {
      userA,
      userB,
      state: 'pending',
      actorId: requesterId,
      createdAt: now,
      respondedAt: null,
    },
  };
}

/** Only the person who received a request may accept it. */
export function acceptFriendship(
  friendship: Friendship,
  viewerId: string,
  now: string,
): Friendship | null {
  if (friendship.state !== 'pending') return null;
  if (friendship.actorId === viewerId) return null;
  if (viewerId !== friendship.userA && viewerId !== friendship.userB) return null;
  return { ...friendship, state: 'accepted', respondedAt: now };
}

/**
 * Blocking always wins.
 *
 * It overrides an accepted friendship and a pending request alike, and the
 * actor becomes whoever blocked — so the other side can never simply re-accept
 * their way back in.
 */
export function blockUser(
  friendship: Friendship | null,
  blockerId: string,
  otherId: string,
  now: string,
): Friendship {
  const [userA, userB] = canonicalPair(blockerId, otherId);
  return {
    ...(friendship ?? { createdAt: now }),
    userA,
    userB,
    state: 'blocked',
    actorId: blockerId,
    createdAt: friendship?.createdAt ?? now,
    respondedAt: now,
  };
}

/** Only the person who applied a block may lift it. */
export function canUnblock(friendship: Friendship, viewerId: string): boolean {
  return friendship.state === 'blocked' && friendship.actorId === viewerId;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** Reserved so a handle can never impersonate the app or a system page. */
const RESERVED = new Set([
  'shift', 'admin', 'support', 'help', 'settings', 'squad', 'workout',
  'me', 'you', 'system', 'root', 'null', 'undefined', 'anonymous',
]);

export function normalizeHandle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, HANDLE_MAX);
}

export type HandleProblem = 'too-short' | 'too-long' | 'reserved' | 'leading-digit';

export function validateHandle(input: string): HandleProblem | null {
  const handle = normalizeHandle(input);
  if (handle.length < HANDLE_MIN) return 'too-short';
  if (handle.length > HANDLE_MAX) return 'too-long';
  if (RESERVED.has(handle)) return 'reserved';
  // Keeps handles from being mistaken for ids anywhere they appear together.
  if (/^[0-9]/.test(handle)) return 'leading-digit';
  return null;
}

// ---------------------------------------------------------------------------
// What friends can see
// ---------------------------------------------------------------------------

export interface PrivacySettings {
  /** Anyone can find you by handle. Off means invite-only. */
  discoverable: boolean;
  shareWorkoutCount: boolean;
  shareStreak: boolean;
  shareMuscleSplit: boolean;
  sharePersonalRecords: boolean;
  /**
   * Off by default and deliberately so.
   *
   * Two friends of different bodyweights comparing kilos turns training into a
   * leaderboard, and the smaller lifter loses every time. A PR is shareable as
   * an event — "hit a new bench best" — without the number attached.
   */
  shareAbsoluteWeights: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  discoverable: true,
  shareWorkoutCount: true,
  shareStreak: true,
  shareMuscleSplit: true,
  sharePersonalRecords: true,
  shareAbsoluteWeights: false,
};

export interface FriendStats {
  workoutsThisWeek: number;
  workoutsTotal: number;
  currentStreakWeeks: number;
  /** Canonical muscle -> share of working sets, summing to 1. */
  muscleSplit: Record<string, number>;
  /** Recent personal records as events, not numbers. */
  recentRecords: { exerciseName: string; achievedAt: string; improvementPct: number | null }[];
  lastWorkoutAt: string | null;
}

export type VisibleStats = Partial<FriendStats>;

/**
 * Filter someone's stats down to what they have agreed to share, and what the
 * viewer is entitled to see.
 *
 * Applied on the client *and* enforced by row level security — this function
 * decides what to render, the database decides what can be fetched. Either one
 * alone would be a privacy bug waiting for the other to be bypassed.
 */
export function visibleStats(
  stats: FriendStats,
  privacy: PrivacySettings,
  relation: Relation,
): VisibleStats {
  if (relation !== 'friends') return {};

  const out: VisibleStats = {};
  if (privacy.shareWorkoutCount) {
    out.workoutsThisWeek = stats.workoutsThisWeek;
    out.workoutsTotal = stats.workoutsTotal;
    out.lastWorkoutAt = stats.lastWorkoutAt;
  }
  if (privacy.shareStreak) out.currentStreakWeeks = stats.currentStreakWeeks;
  if (privacy.shareMuscleSplit) out.muscleSplit = stats.muscleSplit;
  if (privacy.sharePersonalRecords) {
    out.recentRecords = privacy.shareAbsoluteWeights
      ? stats.recentRecords
      : // The event survives, the number does not.
        stats.recentRecords.map((r) => ({ ...r, improvementPct: null }));
  }
  return out;
}

/**
 * Whether the viewer may load this person's avatar at all.
 *
 * Friends always can. So can anyone searching, **provided the owner made
 * themselves discoverable** — because a search result without a face is
 * useless: you cannot tell which of three people called Ana is the one you
 * train with, and a friend request sent to the wrong person is not recoverable
 * by the sender.
 *
 * `discoverable` is therefore the single control. Turning it off removes you
 * from search entirely, photo and all; leaving it on means your picture is part
 * of what makes you findable. A block overrides both.
 */
export function canSeeAvatar(
  relation: Relation,
  isSelf: boolean,
  isDiscoverable = false,
): boolean {
  if (isSelf) return true;
  if (relation === 'blocked-me' || relation === 'blocked-by-me') return false;
  if (relation === 'friends') return true;
  return isDiscoverable;
}

/**
 * Consecutive weeks with at least one workout, counting back from this week.
 *
 * Weeks rather than days: nobody trains daily, and a day-based streak punishes
 * exactly the rest days the programme prescribes.
 */
export function streakWeeks(
  workoutDates: readonly string[],
  nowMs: number,
  weekStartsOn: 'monday' | 'sunday' | 'saturday' = 'monday',
): number {
  if (workoutDates.length === 0) return 0;

  const offset = weekStartsOn === 'monday' ? 1 : weekStartsOn === 'saturday' ? 6 : 0;
  const weekIndex = (ms: number) => Math.floor((ms / 86_400_000 - offset + 4) / 7);

  const weeks = new Set(workoutDates.map((d) => weekIndex(Date.parse(d))));
  const thisWeek = weekIndex(nowMs);

  let streak = 0;
  // Starting from last week keeps a streak alive mid-week: you have not broken
  // anything by not having trained yet on a Monday morning.
  let cursor = weeks.has(thisWeek) ? thisWeek : thisWeek - 1;
  while (weeks.has(cursor)) {
    streak++;
    cursor--;
  }
  return streak;
}

/** Share of working sets per target muscle, normalised to 1. */
export function muscleSplit(targets: readonly string[]): Record<string, number> {
  if (targets.length === 0) return {};
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target, (counts.get(target) ?? 0) + 1);

  const out: Record<string, number> = {};
  for (const [muscle, count] of counts) {
    out[muscle] = Math.round((count / targets.length) * 1000) / 1000;
  }
  return out;
}
