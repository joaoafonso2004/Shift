import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AWAY_AFTER_MS,
  bestOffset,
  hapticFor,
  liveness,
  nextInRotation,
  onDeck,
  podWidth,
  railMembers,
  resolveFocus,
  restProgress,
  restRemainingS,
  STALLED_AFTER_MS,
  turnsUntil,
  type SquadMember,
  type SquadSnapshot,
} from '../src/domain/coop.ts';
import type { MemberState } from '../src/domain/types.ts';

const NOW = Date.parse('2026-08-01T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function member(
  userId: string,
  queuePos: number,
  over: Partial<SquadMember> = {},
): SquadMember {
  return {
    userId,
    displayName: userId.toUpperCase(),
    colorSlot: (queuePos % 4) as 0 | 1 | 2 | 3,
    queuePos,
    state: 'ready' as MemberState,
    currentSetIndex: 0,
    targetSets: 3,
    plannedLoadKg: 80,
    relativeIntensity: 0.8,
    restEndsAt: null,
    restTargetS: 90,
    avgWorkS: 40,
    lastSeenAt: iso(0),
    ...over,
  };
}

function squad(
  members: SquadMember[],
  over: Partial<SquadSnapshot> = {},
): SquadSnapshot {
  return {
    sessionId: 's1',
    selfId: 'ana',
    members,
    activeUserId: members[0]?.userId ?? null,
    turnStartedAt: iso(0),
    loadedKg: 100,
    direction: 1,
    ...over,
  };
}

const four = () => [member('ana', 0), member('bo', 1), member('cy', 2), member('dee', 3)];

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

test('you are never in the squad rail', () => {
  const rail = railMembers(squad(four()));
  assert.equal(rail.length, 3);
  assert.equal(rail.some((m) => m.userId === 'ana'), false);
});

test('the rail holds at most three pods at every squad size', () => {
  for (const n of [1, 2, 3, 4]) {
    const members = four().slice(0, n);
    const rail = railMembers(squad(members));
    assert.equal(rail.length, n - 1, `N=${n} should render ${n - 1} pods`);
    assert.ok(rail.length <= 3);
  }
});

test('liveness degrades in three stages', () => {
  assert.equal(liveness(member('bo', 1, { lastSeenAt: iso(-1000) }), NOW), 'live');
  assert.equal(liveness(member('bo', 1, { lastSeenAt: iso(-AWAY_AFTER_MS) }), NOW), 'away');
  assert.equal(liveness(member('bo', 1, { lastSeenAt: iso(-STALLED_AFTER_MS) }), NOW), 'stalled');
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('rotation follows queue order and wraps at the round boundary', () => {
  const members = four();
  assert.equal(nextInRotation(members, 'ana', 1), 'bo');
  assert.equal(nextInRotation(members, 'cy', 1), 'dee');
  assert.equal(nextInRotation(members, 'dee', 1), 'ana', 'wraps to the front');
});

test('a reversed station rotates backwards', () => {
  const members = four();
  assert.equal(nextInRotation(members, 'dee', -1), 'cy');
  assert.equal(nextInRotation(members, 'ana', -1), 'dee', 'wraps to the back');
});

test('the rotation skips members who dropped, so four are never blocked by one', () => {
  const members = [
    member('ana', 0),
    member('bo', 1, { state: 'away' }),
    member('cy', 2, { state: 'stalled' }),
    member('dee', 3),
  ];
  assert.equal(nextInRotation(members, 'ana', 1), 'dee');
});

test('an empty or fully-dropped squad yields nobody rather than looping', () => {
  assert.equal(nextInRotation([], null, 1), null);
  assert.equal(
    nextInRotation([member('bo', 0, { state: 'away' })], null, 1),
    null,
  );
});

test('turnsUntil counts positions around the rotation', () => {
  const members = four();
  assert.equal(turnsUntil(members, 'ana', 1, 'ana'), 0);
  assert.equal(turnsUntil(members, 'ana', 1, 'bo'), 1);
  assert.equal(turnsUntil(members, 'ana', 1, 'dee'), 3);
  assert.equal(turnsUntil(members, 'dee', 1, 'ana'), 1, 'across the boundary');
});

// ---------------------------------------------------------------------------
// On deck
// ---------------------------------------------------------------------------

test('on-deck reports the wait and the plate change', () => {
  const snapshot = squad(four(), { selfId: 'cy', activeUserId: 'ana', loadedKg: 100 });
  const deck = onDeck(snapshot)!;

  assert.equal(deck.turnsAway, 2);
  assert.equal(deck.etaS, 2 * (40 + 12), 'two lifters of work plus changeovers');
  assert.equal(deck.loadFromKg, 100);
  assert.equal(deck.loadToKg, 80);
});

test('on-deck is zero turns away when it is your turn', () => {
  const deck = onDeck(squad(four(), { selfId: 'ana', activeUserId: 'ana' }))!;
  assert.equal(deck.turnsAway, 0);
  assert.equal(deck.etaS, 0);
});

test('a dropped member has no place in the queue', () => {
  const members = four();
  members[0] = member('ana', 0, { state: 'stalled' });
  assert.equal(onDeck(squad(members, { selfId: 'ana', activeUserId: 'bo' })), null);
});

test('the wait shrinks when someone ahead of you drops out', () => {
  const full = onDeck(squad(four(), { selfId: 'dee', activeUserId: 'ana' }))!;
  const reduced = onDeck(
    squad(
      [member('ana', 0), member('bo', 1, { state: 'away' }), member('cy', 2), member('dee', 3)],
      { selfId: 'dee', activeUserId: 'ana' },
    ),
  )!;
  assert.ok(reduced.etaS < full.etaS);
});

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

test('your rest ending outranks everything else on screen', () => {
  const members = four();
  members[0] = member('ana', 0, { restEndsAt: iso(3000) });
  const focus = resolveFocus(squad(members, { selfId: 'ana', activeUserId: 'bo' }), NOW);
  assert.equal(focus.kind, 'self-rest-ending');
});

test('being on deck outranks watching someone else lift', () => {
  const focus = resolveFocus(squad(four(), { selfId: 'bo', activeUserId: 'ana' }), NOW);
  assert.equal(focus.kind, 'self-on-deck');
});

test('otherwise the active lifter is emphasised', () => {
  const focus = resolveFocus(squad(four(), { selfId: 'dee', activeUserId: 'ana' }), NOW);
  assert.equal(focus.kind, 'member-working');
  assert.equal(focus.userId, 'ana');
});

test('exactly one thing is ever emphasised', () => {
  // Every state that could plausibly compete must still resolve to one focus.
  const members = four();
  members[0] = member('ana', 0, { restEndsAt: iso(2000) });
  const cases: SquadSnapshot[] = [
    squad(members, { selfId: 'ana', activeUserId: 'ana' }),
    squad(members, { selfId: 'ana', activeUserId: 'dee' }),
    squad(four(), { selfId: 'ana', activeUserId: null }),
    squad([], { selfId: 'ana', activeUserId: null }),
  ];
  for (const snapshot of cases) {
    const focus = resolveFocus(snapshot, NOW);
    assert.equal(typeof focus.kind, 'string');
    assert.ok(focus.userId === null || typeof focus.userId === 'string');
  }
});

test('a rest that already expired does not hold the screen', () => {
  const members = four();
  members[0] = member('ana', 0, { restEndsAt: iso(-1000) });
  const focus = resolveFocus(squad(members, { selfId: 'ana', activeUserId: 'bo' }), NOW);
  assert.notEqual(focus.kind, 'self-rest-ending');
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('pod width scales continuously with squad size, with no breakpoints', () => {
  const rail = 320;
  const w2 = podWidth(rail, 2);
  const w3 = podWidth(rail, 3);
  const w4 = podWidth(rail, 4);

  assert.ok(w2 > w3 && w3 > w4, 'more members means narrower pods');
  assert.equal(w2, rail, 'a pair shows one full-width pod');
  assert.ok(w4 > 0);
});

test('pod width never goes negative or divides by zero', () => {
  assert.equal(podWidth(0, 4), 0);
  assert.ok(podWidth(320, 1) > 0, 'solo still reserves the rail');
  assert.ok(podWidth(10, 4) >= 0);
});

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------

test('your own events buzz; other people finishing sets do not', () => {
  const snapshot = squad(four(), { selfId: 'ana', activeUserId: 'cy' });
  assert.equal(hapticFor({ type: 'rest_ended', userId: 'ana' }, snapshot), 'commit');
  assert.equal(hapticFor({ type: 'personal_record', userId: 'ana' }, snapshot), 'celebrate');
  assert.equal(hapticFor({ type: 'set_completed', userId: 'dee' }, snapshot), null);
});

test('your own tap does not buzz twice', () => {
  const snapshot = squad(four(), { selfId: 'ana', activeUserId: 'ana' });
  assert.equal(hapticFor({ type: 'set_completed', userId: 'ana' }, snapshot), null);
});

test('the person immediately before you gives you one on-deck tick', () => {
  // bo is active, ana is next: bo finishing is ana's cue.
  const snapshot = squad(four(), { selfId: 'cy', activeUserId: 'bo' });
  assert.equal(hapticFor({ type: 'set_completed', userId: 'bo' }, snapshot), 'tick');
});

test('someone two turns ahead of you is silent', () => {
  const snapshot = squad(four(), { selfId: 'dee', activeUserId: 'bo' });
  assert.equal(hapticFor({ type: 'set_completed', userId: 'bo' }, snapshot), null);
});

test('haptic load is identical at N=2 and N=4', () => {
  // The invariant that keeps users from switching haptics off entirely.
  const countFired = (members: SquadMember[], selfId: string) => {
    const snapshot = squad(members, { selfId, activeUserId: members[0]!.userId });
    let fired = 0;
    for (const m of members) {
      if (hapticFor({ type: 'set_completed', userId: m.userId }, snapshot)) fired++;
      if (hapticFor({ type: 'turn_started', userId: m.userId }, snapshot)) fired++;
    }
    return fired;
  };

  const pair = countFired([member('ana', 0), member('bo', 1)], 'bo');
  const squadOfFour = countFired(four(), 'bo');
  assert.equal(pair, squadOfFour, 'squad size must not multiply haptic events');
});

test('a completed round pulses everyone at once', () => {
  for (const selfId of ['ana', 'bo', 'cy', 'dee']) {
    const snapshot = squad(four(), { selfId });
    assert.equal(hapticFor({ type: 'round_completed' }, snapshot), 'commit');
  }
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

test('rest countdown is measured against server-aligned time', () => {
  const endsAt = iso(30_000);
  assert.equal(restRemainingS(endsAt, NOW, 0), 30);
  // A device 5s behind the server must not think it has 5s more rest.
  assert.equal(restRemainingS(endsAt, NOW, 5_000), 25);
});

test('a finished or absent timer reads zero, never negative', () => {
  assert.equal(restRemainingS(iso(-10_000), NOW, 0), 0);
  assert.equal(restRemainingS(null, NOW, 0), 0);
});

test('rest progress runs from zero to one and clamps', () => {
  assert.equal(restProgress(iso(90_000), 90, NOW, 0), 0);
  assert.equal(restProgress(iso(45_000), 90, NOW, 0), 0.5);
  assert.equal(restProgress(iso(-5_000), 90, NOW, 0), 1);
  assert.equal(restProgress(null, 90, NOW, 0), 1);
});

test('clock offset keeps the fastest round trip, not the average', () => {
  // One delayed sample must not drag the estimate: averaging these gives a
  // badly wrong offset, and two phones would buzz visibly apart.
  const offset = bestOffset([
    { sentMs: 1000, serverMs: 1520, receivedMs: 1040 }, // rtt 40  -> offset 500
    { sentMs: 2000, serverMs: 2510, receivedMs: 2600 }, // rtt 600 -> offset 210
    { sentMs: 3000, serverMs: 3515, receivedMs: 3030 }, // rtt 30  -> offset 500
  ]);
  assert.equal(offset, 500);
});

test('clock offset survives having no usable samples', () => {
  assert.equal(bestOffset([]), 0);
  assert.equal(bestOffset([{ sentMs: 100, serverMs: 100, receivedMs: 50 }]), 0);
});
