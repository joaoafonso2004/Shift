import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBarbellLattice } from '../src/domain/plates.ts';
import type { BarConfig, PlateInventory } from '../src/domain/plates.ts';
import { planStation } from '../src/domain/rotation.ts';
import {
  buildProgressionState,
  plannedLoadFrom,
  predictNextSession,
  relativeIntensity,
} from '../src/domain/progression.ts';
import type { SessionRecord } from '../src/domain/progression.ts';
import type { Member } from '../src/domain/types.ts';

/**
 * The whole domain, end to end: four people's training histories become four
 * predictions, which become one rotation with a plate plan.
 *
 * This is the path that has to hold for lazy logging to work in a squad — if any
 * link produces a load the bar cannot express, someone types a number.
 */

const BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
const GYM: PlateInventory = { '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2 };
const LATTICE = buildBarbellLattice(BAR, GYM);
const NOW = '2026-08-01T10:00:00Z';

function day(offset: number): string {
  return new Date(Date.parse(NOW) - offset * 86_400_000).toISOString();
}

function session(at: string, weight: number, reps: number, sets = 3): SessionRecord {
  return {
    at,
    sets: Array.from({ length: sets }, (_, i) => ({
      setIndex: i,
      weightKg: weight,
      reps,
      rpe: null,
      isWarmup: false,
      completedAt: at,
    })),
  };
}

const HISTORIES: Record<string, SessionRecord[]> = {
  // Progressing: hit the top of the range, should get a bump.
  Ana: [session(day(21), 55, 10), session(day(14), 57.5, 11), session(day(7), 57.5, 12)],
  // Mid-range: same weight, one more rep.
  Bo: [session(day(21), 80, 8), session(day(14), 80, 9), session(day(7), 80, 10)],
  // Two short sessions in a row: due a deload.
  Cy: [session(day(21), 100, 10), session(day(14), 100, 6), session(day(7), 100, 5)],
  // Strongest, and progressing.
  Dee: [session(day(21), 115, 10), session(day(14), 117.5, 11), session(day(7), 117.5, 12)],
};

function squadFromHistory(): { members: Member[]; intensities: Map<string, number | null> } {
  const members: Member[] = [];
  const intensities = new Map<string, number | null>();

  Object.entries(HISTORIES).forEach(([id, sessions], i) => {
    const state = buildProgressionState('squat', sessions);
    const prediction = predictNextSession({ state, now: NOW, lattice: LATTICE });
    const load = plannedLoadFrom(prediction);

    members.push({
      id,
      colorSlot: i as 0 | 1 | 2 | 3,
      plannedLoadKg: load,
      plannedReps: prediction.sets[0]!.reps,
      targetSets: prediction.sets.length,
      avgWorkS: 40,
      restTargetS: 90,
      state: 'ready',
    });
    intensities.set(id, relativeIntensity(load, state.bestE1rm));
  });

  return { members, intensities };
}

test('four training histories become one loadable rotation', () => {
  const { members } = squadFromHistory();
  const plan = planStation({ members, lattice: LATTICE, rounds: 3, pacingMode: 'auto' });

  assert.equal(plan.slots.length, 12);
  for (const slot of plan.slots) {
    assert.ok(LATTICE.totals.includes(slot.loadKg), `${slot.loadKg}kg is not loadable`);
    assert.equal(
      slot.loadKg,
      slot.requestedKg,
      'a prediction already snapped to the lattice must survive planning unchanged',
    );
  }
});

test('each lifter gets the progression their own history earned', () => {
  const { members } = squadFromHistory();
  const byId = new Map(members.map((m) => [m.id, m]));

  assert.equal(byId.get('Ana')!.plannedLoadKg, 60, 'hit 12 reps — up 2.5kg');
  assert.equal(byId.get('Bo')!.plannedLoadKg, 80, 'mid-range — hold weight');
  assert.equal(byId.get('Bo')!.plannedReps, 11, '...and add a rep');
  assert.ok(byId.get('Cy')!.plannedLoadKg < 100, 'two short sessions — deload');
  assert.equal(byId.get('Dee')!.plannedLoadKg, 120, 'hit 12 reps — up 2.5kg');
});

test('the rotation orders by predicted load, lightest first', () => {
  const { members } = squadFromHistory();
  const plan = planStation({ members, lattice: LATTICE, rounds: 1, pacingMode: 'even' });
  assert.deepEqual(
    plan.slots.map((s) => s.memberId),
    ['Ana', 'Bo', 'Cy', 'Dee'],
  );
});

test('nobody has to type a number to start the session', () => {
  const { members } = squadFromHistory();
  for (const m of members) {
    assert.ok(m.plannedLoadKg > 0, `${m.id} has no predicted load`);
    assert.ok(m.plannedReps > 0, `${m.id} has no predicted reps`);
    assert.ok(m.targetSets > 0, `${m.id} has no predicted set count`);
  }
});

test('the squad rail can compare four lifters without comparing kilos', () => {
  const { members, intensities } = squadFromHistory();

  // Absolute loads span a huge range — which is exactly why the rail must not
  // show them side by side (§6.3).
  const loads = members.map((m) => m.plannedLoadKg);
  assert.ok(Math.max(...loads) / Math.min(...loads) > 1.9);

  for (const [id, ri] of intensities) {
    assert.ok(ri !== null, `${id} has no relative intensity`);
    assert.ok(ri! > 0.4 && ri! < 1.1, `${id}'s relative intensity ${ri} is out of range`);
  }

  const values = [...intensities.values()].map((v) => v!);
  assert.ok(
    Math.max(...values) - Math.min(...values) < 0.35,
    'relative intensity should cluster where absolute load does not — that is the point',
  );
});

test('a squad member swapping to a new exercise still gets a prefilled card', () => {
  const benchState = buildProgressionState('bench', [session(day(7), 100, 10)]);
  const prediction = predictNextSession({
    state: buildProgressionState('incline', []),
    now: NOW,
    lattice: LATTICE,
    transfer: {
      fromExerciseId: 'bench',
      state: benchState,
      ratio: 0.8,
      label: 'your bench press',
    },
  });

  const member: Member = {
    id: 'Ana',
    colorSlot: 0,
    plannedLoadKg: plannedLoadFrom(prediction),
    plannedReps: prediction.sets[0]!.reps,
    targetSets: prediction.sets.length,
    avgWorkS: 40,
    restTargetS: 90,
    state: 'ready',
  };

  const plan = planStation({ members: [member], lattice: LATTICE, rounds: 2, pacingMode: 'auto' });
  assert.ok(LATTICE.totals.includes(plan.slots[0]!.loadKg));
  assert.equal(prediction.confidence, 'low', 'a transferred guess must be flagged as such');
});
