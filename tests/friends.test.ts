import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptFriendship,
  blockUser,
  canonicalPair,
  canSeeAvatar,
  canUnblock,
  DEFAULT_PRIVACY,
  muscleSplit,
  normalizeHandle,
  relationFor,
  requestFriendship,
  streakWeeks,
  validateHandle,
  visibleStats,
  type FriendStats,
  type Friendship,
} from '../src/domain/friends.ts';

const NOW = '2026-08-01T10:00:00.000Z';
const ANA = 'aaaa-1111';
const BO = 'bbbb-2222';
const CY = 'cccc-3333';

function pending(actorId: string, other: string): Friendship {
  const [userA, userB] = canonicalPair(actorId, other);
  return { userA, userB, state: 'pending', actorId, createdAt: NOW, respondedAt: null };
}

// ---------------------------------------------------------------------------
// Canonical pairing
// ---------------------------------------------------------------------------

test('a pair orders the same way whichever side asks', () => {
  // One row per relationship. Two rows means an accept can land on one and not
  // the other, leaving a friendship that exists for one person only.
  assert.deepEqual(canonicalPair(ANA, BO), canonicalPair(BO, ANA));
  assert.deepEqual(canonicalPair(ANA, BO), [ANA, BO]);
});

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

test('a request creates one pending row', () => {
  const result = requestFriendship(null, ANA, BO, NOW);
  assert.ok(result.ok && result.action === 'create');
  assert.equal(result.friendship.state, 'pending');
  assert.equal(result.friendship.actorId, ANA);
});

test('crossing requests are treated as mutual consent', () => {
  // Otherwise each person sees an invitation from someone they already invited,
  // and neither knows who is supposed to act.
  const existing = pending(BO, ANA);
  const result = requestFriendship(existing, ANA, BO, NOW);

  assert.ok(result.ok && result.action === 'auto-accept');
  assert.equal(result.friendship.state, 'accepted');
});

test('you cannot befriend yourself', () => {
  const result = requestFriendship(null, ANA, ANA, NOW);
  assert.ok(!result.ok && result.reason === 'self');
});

test('re-sending your own pending request changes nothing', () => {
  const result = requestFriendship(pending(ANA, BO), ANA, BO, NOW);
  assert.ok(!result.ok && result.reason === 'already-sent');
});

test('a request to an existing friend is rejected', () => {
  const friends: Friendship = { ...pending(ANA, BO), state: 'accepted' };
  const result = requestFriendship(friends, ANA, BO, NOW);
  assert.ok(!result.ok && result.reason === 'already-friends');
});

test('a block cannot be routed around by sending a fresh request', () => {
  const blocked = blockUser(null, BO, ANA, NOW);
  const result = requestFriendship(blocked, ANA, BO, NOW);
  assert.ok(!result.ok && result.reason === 'blocked');
});

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

test('only the recipient can accept', () => {
  const request = pending(ANA, BO);
  assert.equal(acceptFriendship(request, ANA, NOW), null, 'the sender cannot self-accept');
  assert.ok(acceptFriendship(request, BO, NOW));
});

test('a stranger cannot accept someone else’s request', () => {
  assert.equal(acceptFriendship(pending(ANA, BO), CY, NOW), null);
});

test('an accepted friendship cannot be accepted again', () => {
  const accepted: Friendship = { ...pending(ANA, BO), state: 'accepted' };
  assert.equal(acceptFriendship(accepted, BO, NOW), null);
});

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

test('blocking overrides an existing friendship', () => {
  const friends: Friendship = { ...pending(ANA, BO), state: 'accepted' };
  const blocked = blockUser(friends, ANA, BO, NOW);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.actorId, ANA);
});

test('only the blocker can lift a block', () => {
  const blocked = blockUser(null, ANA, BO, NOW);
  assert.equal(canUnblock(blocked, ANA), true);
  assert.equal(canUnblock(blocked, BO), false, 'the blocked party must not release it');
});

test('each side sees the block from its own perspective', () => {
  const blocked = blockUser(null, ANA, BO, NOW);
  assert.equal(relationFor(blocked, ANA), 'blocked-by-me');
  assert.equal(relationFor(blocked, BO), 'blocked-me');
});

// ---------------------------------------------------------------------------
// Relation
// ---------------------------------------------------------------------------

test('a pending request reads as outgoing to the sender and incoming to the other', () => {
  const request = pending(ANA, BO);
  assert.equal(relationFor(request, ANA), 'outgoing');
  assert.equal(relationFor(request, BO), 'incoming');
});

test('no row means no relation', () => {
  assert.equal(relationFor(null, ANA), 'none');
});

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

test('handles are normalised to something linkable', () => {
  assert.equal(normalizeHandle('  Ana Silva! '), 'anasilva');
  assert.equal(normalizeHandle('BO_99'), 'bo_99');
});

test('handles that would impersonate the app are rejected', () => {
  for (const reserved of ['shift', 'admin', 'support', 'settings']) {
    assert.equal(validateHandle(reserved), 'reserved', `${reserved} must not be claimable`);
  }
});

test('handles cannot start with a digit, so they never read as an id', () => {
  assert.equal(validateHandle('1ana'), 'leading-digit');
  assert.equal(validateHandle('ana1'), null);
});

test('handle length is bounded at both ends', () => {
  assert.equal(validateHandle('ab'), 'too-short');
  assert.equal(validateHandle('a'.repeat(30)), null, 'over-long input is truncated, then valid');
  assert.equal(validateHandle(''), 'too-short');
});

// ---------------------------------------------------------------------------
// Visibility — the part that matters
// ---------------------------------------------------------------------------

const STATS: FriendStats = {
  workoutsThisWeek: 3,
  workoutsTotal: 142,
  currentStreakWeeks: 7,
  muscleSplit: { pectorals: 0.3, quads: 0.4, lats: 0.3 },
  recentRecords: [{ exerciseName: 'Barbell bench press', achievedAt: NOW, improvementPct: 4.2 }],
  lastWorkoutAt: NOW,
};

test('a stranger sees nothing at all', () => {
  assert.deepEqual(visibleStats(STATS, DEFAULT_PRIVACY, 'none'), {});
  assert.deepEqual(visibleStats(STATS, DEFAULT_PRIVACY, 'incoming'), {});
  assert.deepEqual(visibleStats(STATS, DEFAULT_PRIVACY, 'blocked-me'), {});
});

test('a friend sees what was shared', () => {
  const visible = visibleStats(STATS, DEFAULT_PRIVACY, 'friends');
  assert.equal(visible.workoutsThisWeek, 3);
  assert.equal(visible.currentStreakWeeks, 7);
  assert.deepEqual(visible.muscleSplit, STATS.muscleSplit);
});

test('personal records are shared as events, with the number stripped', () => {
  // The whole point: "hit a new bench best" is motivating; "benches 120kg" next
  // to a friend who benches 60 is not.
  const visible = visibleStats(STATS, DEFAULT_PRIVACY, 'friends');
  assert.equal(visible.recentRecords?.[0]?.exerciseName, 'Barbell bench press');
  assert.equal(visible.recentRecords?.[0]?.improvementPct, null);
});

test('numbers appear only when explicitly opted into', () => {
  const visible = visibleStats(
    STATS,
    { ...DEFAULT_PRIVACY, shareAbsoluteWeights: true },
    'friends',
  );
  assert.equal(visible.recentRecords?.[0]?.improvementPct, 4.2);
});

test('sharing weights is off by default', () => {
  assert.equal(DEFAULT_PRIVACY.shareAbsoluteWeights, false);
});

test('each privacy switch hides only its own field', () => {
  const visible = visibleStats(
    STATS,
    { ...DEFAULT_PRIVACY, shareStreak: false, shareMuscleSplit: false },
    'friends',
  );
  assert.equal(visible.currentStreakWeeks, undefined);
  assert.equal(visible.muscleSplit, undefined);
  assert.equal(visible.workoutsTotal, 142, 'unrelated fields survive');
});

test('friends and you can always see the photo', () => {
  assert.equal(canSeeAvatar('friends', false), true);
  assert.equal(canSeeAvatar('none', true), true);
});

test('a discoverable stranger shows their photo in search', () => {
  // Without this a search result has no face, and you cannot tell which of
  // three people called Ana is the one you actually train with.
  assert.equal(canSeeAvatar('none', false, true), true);
  assert.equal(canSeeAvatar('outgoing', false, true), true);
});

test('opting out of discovery hides the photo along with everything else', () => {
  assert.equal(canSeeAvatar('none', false, false), false);
});

test('a block hides the photo even from someone discoverable', () => {
  assert.equal(canSeeAvatar('blocked-me', false, true), false);
  assert.equal(canSeeAvatar('blocked-by-me', false, true), false);
});

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

const WEEK = 7 * 86_400_000;

test('a streak counts weeks, not days', () => {
  // Day streaks punish exactly the rest days a programme prescribes.
  const now = Date.parse('2026-08-01T10:00:00Z');
  const dates = [0, 1, 2, 3].map((w) => new Date(now - w * WEEK).toISOString());
  assert.equal(streakWeeks(dates, now), 4);
});

test('a gap ends the streak', () => {
  const now = Date.parse('2026-08-01T10:00:00Z');
  const dates = [0, 1, 3, 4].map((w) => new Date(now - w * WEEK).toISOString());
  assert.equal(streakWeeks(dates, now), 2);
});

test('not having trained yet this week does not break a streak', () => {
  // Monday morning must not wipe out eight weeks of work.
  const now = Date.parse('2026-08-01T10:00:00Z');
  const dates = [1, 2, 3].map((w) => new Date(now - w * WEEK).toISOString());
  assert.equal(streakWeeks(dates, now), 3);
});

test('no history is a streak of zero, not a crash', () => {
  assert.equal(streakWeeks([], Date.now()), 0);
});

test('muscle split is a normalised share', () => {
  const split = muscleSplit(['quads', 'quads', 'pectorals', 'lats']);
  assert.equal(split.quads, 0.5);
  assert.equal(split.pectorals, 0.25);
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 0.01);
});

test('an empty split is empty, not NaN', () => {
  assert.deepEqual(muscleSplit([]), {});
});
