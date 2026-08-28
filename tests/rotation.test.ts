import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBarbellLattice } from '../src/domain/plates.ts';
import type { BarConfig, PlateInventory } from '../src/domain/plates.ts';
import { activeMembers, nextInRotation, planStation } from '../src/domain/rotation.ts';
import type { Member, MemberId, MemberState, StationPlan } from '../src/domain/types.ts';

const BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
const GYM: PlateInventory = { '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2 };
const LATTICE = buildBarbellLattice(BAR, GYM);

let slot = 0;
function member(id: string, loadKg: number, over: Partial<Member> = {}): Member {
  return {
    id,
    colorSlot: (slot++ % 4) as 0 | 1 | 2 | 3,
    plannedLoadKg: loadKg,
    plannedReps: 8,
    targetSets: 3,
    avgWorkS: 40,
    restTargetS: 90,
    state: 'ready',
    ...over,
  };
}

const squad4 = () => [member('d', 120), member('b', 80), member('a', 60), member('c', 100)];
const squad2 = () => [member('b', 80), member('a', 60)];

function roundOrder(plan: StationPlan, roundIndex: number): MemberId[] {
  return plan.slots.filter((s) => s.roundIndex === roundIndex).map((s) => s.memberId);
}

test('rounds are ordered ascending by load regardless of input order', () => {
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 1,
    pacingMode: 'even',
  });
  assert.deepEqual(roundOrder(plan, 0), ['a', 'b', 'c', 'd']);
});

test('even pacing repeats the same order every round', () => {
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'even',
  });
  assert.deepEqual(roundOrder(plan, 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(roundOrder(plan, 1), ['a', 'b', 'c', 'd']);
  assert.deepEqual(roundOrder(plan, 2), ['a', 'b', 'c', 'd']);
});

test('flow pacing reverses alternate rounds, so the bar is untouched at the boundary', () => {
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'flow',
  });
  assert.deepEqual(roundOrder(plan, 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(roundOrder(plan, 1), ['d', 'c', 'b', 'a']);

  const boundary = plan.slots.find((s) => s.roundIndex === 1 && s.slot === 0)!;
  assert.deepEqual(
    boundary.plateDelta,
    { add: [], remove: [] },
    'serpentine boundary must require no plate change',
  );
});

test('flow moves fewer plates than even', () => {
  const common = { members: squad4(), lattice: LATTICE, rounds: 4 } as const;
  const flow = planStation({ ...common, pacingMode: 'flow' });
  const even = planStation({ ...common, pacingMode: 'even' });
  assert.ok(
    flow.plateMoves < even.plateMoves,
    `flow (${flow.plateMoves}) should move fewer plates than even (${even.plateMoves})`,
  );
});

test('flow without idle starves the boundary lifter — the cost it trades against', () => {
  // Force the no-idle serpentine by giving everyone a rest target the rotation
  // already satisfies, so the idle variant has nothing to add.
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 2,
    pacingMode: 'flow',
  });
  const d = plan.cadence.members.find((m) => m.memberId === 'd')!;
  const others = plan.cadence.members.filter((m) => m.memberId !== 'd');

  assert.ok(d.minRestS !== null);
  for (const o of others) {
    assert.ok(
      o.minRestS === null || d.minRestS! < o.minRestS,
      'the boundary lifter must be the one paying for zero plate changes',
    );
  }
});

test('auto never ships a plan with rest debt when a debt-free one exists', () => {
  const auto = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 4,
    pacingMode: 'auto',
  });
  assert.equal(auto.cadence.totalViolationS, 0);
});

test('auto prefers the faster plan once rest debt is tied', () => {
  const common = { members: squad4(), lattice: LATTICE, rounds: 4 } as const;
  const auto = planStation({ ...common, pacingMode: 'auto' });
  const even = planStation({ ...common, pacingMode: 'even' });
  const flow = planStation({ ...common, pacingMode: 'flow' });

  assert.equal(even.cadence.totalViolationS, 0, 'precondition: even is already debt-free');
  assert.ok(
    auto.totalTimeS <= even.totalTimeS && auto.totalTimeS <= flow.totalTimeS,
    `auto (${auto.totalTimeS}s) must not be slower than even (${even.totalTimeS}s) or flow (${flow.totalTimeS}s)`,
  );
  assert.match(auto.rationale, /plate moves/);
});

test('saved plate moves never justify more time standing around', () => {
  // Flow saves plate changes but idles the boundary lifter. Those moves are
  // already priced into total time, so a slower plan must never win on them.
  const common = { members: squad4(), lattice: LATTICE, rounds: 4 } as const;
  const auto = planStation({ ...common, pacingMode: 'auto' });
  const flow = planStation({ ...common, pacingMode: 'flow' });

  assert.ok(flow.plateMoves < auto.plateMoves, 'precondition: flow does move fewer plates');
  assert.ok(
    auto.totalTimeS < flow.totalTimeS,
    'the chosen plan should be the faster one despite handling more plates',
  );
});

test('plans are deterministic — every client derives the same rotation', () => {
  const build = () =>
    planStation({ members: squad4(), lattice: LATTICE, rounds: 3, pacingMode: 'auto' });
  assert.deepEqual(build(), build());
});

test('input order does not change the plan', () => {
  const forward = planStation({
    members: [member('a', 60), member('b', 80), member('c', 100)],
    lattice: LATTICE,
    rounds: 2,
    pacingMode: 'auto',
  });
  const shuffled = planStation({
    members: [member('c', 100), member('a', 60), member('b', 80)],
    lattice: LATTICE,
    rounds: 2,
    pacingMode: 'auto',
  });
  assert.deepEqual(
    forward.slots.map((s) => s.memberId),
    shuffled.slots.map((s) => s.memberId),
  );
});

test('every planned load is achievable on the bar', () => {
  const plan = planStation({
    members: [member('a', 61), member('b', 83.7), member('c', 100)],
    lattice: LATTICE,
    rounds: 2,
    pacingMode: 'auto',
  });
  for (const s of plan.slots) {
    assert.ok(LATTICE.totals.includes(s.loadKg), `${s.loadKg}kg is not achievable`);
    assert.ok(Math.abs(s.loadKg - s.requestedKg) <= 2.5, 'snap should stay close to the prediction');
  }
});

test('away and stalled members are excluded from the rotation', () => {
  const members = [
    member('a', 60),
    member('b', 80, { state: 'away' }),
    member('c', 100, { state: 'stalled' }),
    member('d', 120),
  ];
  assert.deepEqual(
    activeMembers(members).map((m) => m.id),
    ['a', 'd'],
  );

  const plan = planStation({ members, lattice: LATTICE, rounds: 2, pacingMode: 'auto' });
  const ids = new Set(plan.slots.map((s) => s.memberId));
  assert.deepEqual([...ids].sort(), ['a', 'd']);
});

test('nextInRotation skips members who dropped after planning', () => {
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 2,
    pacingMode: 'even',
  });
  const states = new Map<MemberId, MemberState>([
    ['a', 'ready'],
    ['b', 'away'],
    ['c', 'ready'],
    ['d', 'ready'],
  ]);

  const next = nextInRotation(plan, 0, states);
  assert.equal(next?.memberId, 'c', 'b is away, so the turn passes to c');

  const last = nextInRotation(plan, plan.slots.length - 1, states);
  assert.equal(last, null, 'no turns remain past the end of the plan');
});

test('a solo lifter gets their full rest, not a changeover', () => {
  const plan = planStation({
    members: [member('a', 100)],
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'auto',
  });
  assert.equal(plan.plateMoves, plan.slots[0]!.perSide.length, 'load the bar once, then leave it');
  const a = plan.cadence.members[0]!;
  assert.ok(a.minRestS! >= 90, `solo rest was ${a.minRestS}s, expected the full 90s target`);
});

test('an empty station plans nothing rather than throwing', () => {
  const plan = planStation({ members: [], lattice: LATTICE, rounds: 3, pacingMode: 'auto' });
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.totalTimeS, 0);
  assert.match(plan.rationale, /No active members/);
});

test('timeline is monotonic and internally consistent', () => {
  const plan = planStation({
    members: squad4(),
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'auto',
  });
  let prevEnd = 0;
  plan.slots.forEach((s, i) => {
    assert.equal(s.ordinal, i);
    assert.ok(s.startsAtS >= prevEnd, `slot ${i} starts before the previous one ended`);
    assert.equal(s.endsAtS - s.startsAtS, 40, 'work time must match avgWorkS');
    prevEnd = s.endsAtS;
  });
  assert.equal(plan.totalTimeS, Math.round(prevEnd));
});

test('identical loads across the squad need no plate work at all', () => {
  const plan = planStation({
    members: [member('a', 100), member('b', 100), member('c', 100)],
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'auto',
  });
  const afterFirst = plan.slots.slice(1);
  for (const s of afterFirst) {
    assert.deepEqual(s.plateDelta, { add: [], remove: [] });
  }
});

test('two-person squads still produce a legal plan', () => {
  const plan = planStation({
    members: squad2(),
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'auto',
  });
  assert.equal(plan.slots.length, 6);
  assert.equal(plan.cadence.totalViolationS, 0, 'auto should buy rest with idle at N=2');
});
