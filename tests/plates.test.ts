import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBarbellLattice,
  buildFixedIncrementLattice,
  DEFAULT_TRANSITION,
  plateDelta,
  plateMoveCount,
  snapTo,
  solveSequence,
  transitionSeconds,
} from '../src/domain/plates.ts';
import type { BarConfig, PlateInventory } from '../src/domain/plates.ts';
import { sumKg } from '../src/domain/units.ts';

const BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
const GYM: PlateInventory = { '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2 };

function totalOf(bar: BarConfig, perSide: readonly number[]): number {
  return bar.barWeightKg + 2 * sumKg(perSide);
}

test('lattice includes the bare bar and stays sorted and unique', () => {
  const l = buildBarbellLattice(BAR, GYM);
  assert.equal(l.totals[0], 20);
  assert.equal(l.minKg, 20);
  for (let i = 1; i < l.totals.length; i++) {
    assert.ok(l.totals[i]! > l.totals[i - 1]!, 'totals must be strictly ascending');
  }
});

test('every plate solution actually sums to its load', () => {
  const l = buildBarbellLattice(BAR, GYM);
  for (const total of l.totals) {
    const perSide = l.platesFor(total);
    assert.equal(totalOf(BAR, perSide), total, `plates for ${total}kg do not sum back`);
  }
});

test('solver finds loads that greedy largest-first cannot', () => {
  // 35kg per side is 20+15. Greedy takes 25 first and then cannot finish.
  const sparse: PlateInventory = { '25': 1, '20': 1, '15': 1 };
  const l = buildBarbellLattice(BAR, sparse);
  assert.ok(l.totals.includes(90), '90kg (35/side) must be achievable');
  assert.deepEqual(l.platesFor(90), [20, 15]);
});

test('fractional plates survive the float boundary', () => {
  const l = buildBarbellLattice(BAR, { '20': 2, '1.25': 1 });
  assert.ok(l.totals.includes(62.5));
  assert.deepEqual(l.platesFor(62.5), [20, 1.25]);
  assert.equal(totalOf(BAR, l.platesFor(62.5)), 62.5);
});

test('unachievable loads return no solution rather than a wrong one', () => {
  const l = buildBarbellLattice(BAR, { '20': 1 });
  assert.deepEqual(l.platesFor(45), []); // 12.5/side is not expressible with a single 20
  assert.deepEqual(l.platesFor(10), []); // below the bar
});

test('snap picks the nearest achievable load, resolving ties downward', () => {
  const totals = [20, 25, 30, 40];
  assert.equal(snapTo(totals, 26), 25);
  assert.equal(snapTo(totals, 29), 30);
  assert.equal(snapTo(totals, 35), 30, 'exact tie must not overshoot');
  assert.equal(snapTo(totals, 5), 20, 'clamps to minimum');
  assert.equal(snapTo(totals, 999), 40, 'clamps to maximum');
});

test('plateDelta is a multiset difference', () => {
  assert.deepEqual(plateDelta([20, 10], [20, 10, 10]), { add: [10], remove: [] });
  assert.deepEqual(plateDelta([25, 5], [20, 10]), { add: [20, 10], remove: [25, 5] });
  assert.deepEqual(plateDelta([20], [20]), { add: [], remove: [] });
});

test('transition cost is setup plus plate handling', () => {
  assert.equal(transitionSeconds({ add: [], remove: [] }), DEFAULT_TRANSITION.setupS);
  assert.equal(
    transitionSeconds({ add: [10], remove: [5] }),
    DEFAULT_TRANSITION.setupS + 2 * DEFAULT_TRANSITION.perPlateS,
  );
});

test('an ascending sequence loads additively and never strips a plate', () => {
  const loads = [60, 80, 100, 120];
  const configs = solveSequence(BAR, GYM, loads);

  configs.forEach((c, i) => assert.equal(totalOf(BAR, c), loads[i]!, `load ${loads[i]} mismatched`));

  for (let i = 1; i < configs.length; i++) {
    const d = plateDelta(configs[i - 1]!, configs[i]!);
    assert.deepEqual(d.remove, [], `step ${i} stripped plates on an ascending sequence`);
  }
});

test('sequence-aware solving beats solving each load in isolation', () => {
  const loads = [60, 80, 100, 120];
  const l = buildBarbellLattice(BAR, GYM);
  const seq = solveSequence(BAR, GYM, loads);

  const cost = (configs: number[][]) => {
    let moves = 0;
    let prev: number[] = [];
    for (const c of configs) {
      moves += plateMoveCount(plateDelta(prev, c));
      prev = c;
    }
    return moves;
  };

  const isolated = loads.map((kg) => l.platesFor(kg));
  assert.ok(
    cost(seq) <= cost(isolated),
    `sequence solve (${cost(seq)}) should not cost more than isolated (${cost(isolated)})`,
  );
});

test('a descending sequence only removes plates when the loads decompose that way', () => {
  // Per side 40/30/20/10 with nothing but 10s: each step is one plate off.
  const configs = solveSequence(BAR, { '10': 4 }, [100, 80, 60, 40]);
  for (let i = 1; i < configs.length; i++) {
    const d = plateDelta(configs[i - 1]!, configs[i]!);
    assert.deepEqual(d.add, [], `step ${i} added plates`);
    assert.equal(d.remove.length, 1, `step ${i} should strip exactly one plate`);
  }
});

test('a descending step swaps minimally instead of re-racking the bar', () => {
  // 50/side is cheapest as [25,25], which cannot simply shed 10kg to reach 40.
  // The right move is one swap (25 off, 15 on), not stripping and reloading.
  const configs = solveSequence(BAR, GYM, [120, 100]);
  const d = plateDelta(configs[0]!, configs[1]!);
  assert.equal(plateMoveCount(d), 2, `expected a single swap, got ${JSON.stringify(d)}`);
  assert.equal(totalOf(BAR, configs[1]!), 100);
});

test('repeating the same load moves nothing', () => {
  const configs = solveSequence(BAR, GYM, [100, 100, 100]);
  assert.deepEqual(plateDelta(configs[0]!, configs[1]!), { add: [], remove: [] });
  assert.deepEqual(plateDelta(configs[1]!, configs[2]!), { add: [], remove: [] });
});

test('fixed-increment kit never reports plate work', () => {
  const l = buildFixedIncrementLattice({ minKg: 2.5, maxKg: 50, stepKg: 2.5 });
  assert.equal(l.isPlateLoaded, false);
  assert.equal(l.snap(31), 30);
  assert.deepEqual(l.platesFor(30), []);
  assert.deepEqual(l.sequence([10, 20, 30]), [[], [], []]);
});
