import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseCadence, baselineRestS, BLOAT_THRESHOLD } from '../src/domain/cadence.ts';
import { buildBarbellLattice } from '../src/domain/plates.ts';
import type { BarConfig, PlateInventory } from '../src/domain/plates.ts';
import { planStation } from '../src/domain/rotation.ts';
import type { Member, TurnSlot } from '../src/domain/types.ts';

const BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
const GYM: PlateInventory = { '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2 };
const LATTICE = buildBarbellLattice(BAR, GYM);

function member(id: string, loadKg: number, over: Partial<Member> = {}): Member {
  return {
    id,
    colorSlot: 0,
    plannedLoadKg: loadKg,
    plannedReps: 8,
    targetSets: 3,
    avgWorkS: 40,
    restTargetS: 90,
    state: 'ready',
    ...over,
  };
}

function slot(memberId: string, restBeforeS: number | null): TurnSlot {
  return {
    roundIndex: 0,
    slot: 0,
    ordinal: 0,
    memberId,
    loadKg: 100,
    requestedKg: 100,
    perSide: [],
    plateDelta: { add: [], remove: [] },
    transitionS: 8,
    idleS: 0,
    startsAtS: 0,
    endsAtS: 40,
    restBeforeS,
  };
}

test('baseline rest is (N-1) x (work + transition)', () => {
  const four = [member('a', 60), member('b', 80), member('c', 100), member('d', 120)];
  assert.equal(baselineRestS(four, 10), 3 * (40 + 10));
  assert.equal(baselineRestS([member('a', 60)], 10), 0, 'a solo lifter has no rotation rest');
});

test('rest grows with squad size — the §6.1 claim, checked', () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => member(String.fromCharCode(97 + i), 60 + i * 20));

  const rest = [2, 3, 4].map((n) => baselineRestS(mk(n), 10));
  assert.deepEqual(rest, [50, 100, 150]);
  assert.ok(rest[0]! < rest[1]! && rest[1]! < rest[2]!);
});

test('the first turn of a member contributes no rest measurement', () => {
  const report = analyseCadence([slot('a', null), slot('a', 120)], [member('a', 100)]);
  assert.deepEqual(report.members[0]!.restGapsS, [120]);
});

test('rest debt is the shortfall summed across turns', () => {
  const report = analyseCadence(
    [slot('a', null), slot('a', 60), slot('a', 30)],
    [member('a', 100)], // 90s target
  );
  assert.equal(report.members[0]!.violationS, 30 + 60);
  assert.equal(report.totalViolationS, 90);
});

test('a four-person rotation is flagged as rest-bloated', () => {
  const four = [member('a', 60), member('b', 80), member('c', 100), member('d', 120)];
  const plan = planStation({ members: four, lattice: LATTICE, rounds: 3, pacingMode: 'even' });

  assert.ok(
    plan.cadence.restPressure > BLOAT_THRESHOLD,
    `expected bloat, got pressure ${plan.cadence.restPressure}`,
  );
  assert.equal(plan.cadence.verdict, 'rest-bloated');
  assert.match(plan.cadence.recommendation!, /Split into two stations \(2\+2\)/);
});

test('splitting a bloated squad in two resolves the bloat', () => {
  const four = [member('a', 60), member('b', 80), member('c', 100), member('d', 120)];
  const whole = planStation({ members: four, lattice: LATTICE, rounds: 3, pacingMode: 'even' });
  const half = planStation({
    members: four.slice(0, 2),
    lattice: LATTICE,
    rounds: 3,
    pacingMode: 'even',
  });

  assert.equal(whole.cadence.verdict, 'rest-bloated');
  assert.ok(
    half.cadence.restPressure < whole.cadence.restPressure,
    'the recommendation must actually reduce rest pressure',
  );
});

test('a fast-paced pair is flagged as rest-starved', () => {
  const pair = [member('a', 60, { restTargetS: 180 }), member('b', 80, { restTargetS: 180 })];
  const plan = planStation({ members: pair, lattice: LATTICE, rounds: 3, pacingMode: 'even' });

  assert.equal(plan.cadence.verdict, 'rest-starved');
  assert.match(plan.cadence.recommendation!, /Merge with another station|filler/);
});

test('a healthy rotation reports ok and suggests nothing', () => {
  const three = [
    member('a', 60, { restTargetS: 110 }),
    member('b', 80, { restTargetS: 110 }),
    member('c', 100, { restTargetS: 110 }),
  ];
  const plan = planStation({ members: three, lattice: LATTICE, rounds: 3, pacingMode: 'even' });
  assert.equal(plan.cadence.verdict, 'ok');
  assert.equal(plan.cadence.recommendation, null);
});

test('the plan reports the rotation-independent baseline alongside measured rest', () => {
  const four = [member('a', 60), member('b', 80), member('c', 100), member('d', 120)];
  const plan = planStation({ members: four, lattice: LATTICE, rounds: 3, pacingMode: 'even' });
  assert.ok(plan.cadence.baselineRestS > 0);
  assert.equal(plan.cadence.baselineRestS, Math.round(baselineRestS(four, 8)));
});
