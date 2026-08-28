import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyUnitSystem,
  DEFAULT_SETTINGS,
  formatWeight,
  IMPERIAL_BAR_KG,
  kgToLb,
  latticeFromSettings,
  lbToKg,
  normalizeSettings,
  restTargetFor,
  schemeFromSettings,
  warmupSets,
} from '../src/domain/settings.ts';

test('defaults produce a working app with no stored settings at all', () => {
  const s = normalizeSettings(null);
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('a rep range stored backwards is repaired, not obeyed', () => {
  const s = normalizeSettings({ repRangeMin: 12, repRangeMax: 8 });
  assert.ok(s.repRangeMin <= s.repRangeMax, `${s.repRangeMin}..${s.repRangeMax}`);
});

test('nonsense values cannot brick the plate solver', () => {
  const s = normalizeSettings({
    barWeightKg: 0,
    dumbbellStepKg: -5,
    machineStepKg: Number.NaN,
    deloadFraction: 4,
    hapticIntensity: 99 as 0,
  });
  assert.ok(s.barWeightKg > 0);
  assert.ok(s.dumbbellStepKg > 0);
  assert.ok(Number.isFinite(s.machineStepKg) && s.machineStepKg > 0);
  assert.ok(s.deloadFraction > 0 && s.deloadFraction < 1);
  assert.ok(s.hapticIntensity >= 0 && s.hapticIntensity <= 3);

  // The repaired settings must still yield a usable lattice.
  const lattice = latticeFromSettings(s, 'barbell');
  assert.ok(lattice.totals.length > 0);
});

test('an empty plate inventory falls back rather than producing a bar with no loads', () => {
  const s = normalizeSettings({ plateInventory: {} });
  assert.ok(Object.keys(s.plateInventory).length > 0);
  assert.ok(latticeFromSettings(s, 'barbell').totals.length > 1);
});

test('warm-up percentages are sorted, filtered and capped', () => {
  const s = normalizeSettings({ warmupPercents: [80, 40, 0, 120, 60, 50, 70, 90] });
  assert.deepEqual(s.warmupPercents, [40, 50, 60, 70, 80]);
});

test('a partial settings object keeps every unspecified default', () => {
  const s = normalizeSettings({ accent: 'mint' });
  assert.equal(s.accent, 'mint');
  assert.equal(s.restCompoundS, DEFAULT_SETTINGS.restCompoundS);
  assert.equal(s.incrementKg.barbell, DEFAULT_SETTINGS.incrementKg.barbell);
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test('unit conversion round-trips', () => {
  assert.ok(Math.abs(lbToKg(kgToLb(100)) - 100) < 1e-9);
  assert.ok(Math.abs(kgToLb(20) - 44.09) < 0.01);
});

test('switching units changes the equipment, not just the label', () => {
  // A US gym has 45lb plates and a 45lb bar. Treating this as a display setting
  // would have the app proposing loads the rack cannot make.
  const imperial = applyUnitSystem(DEFAULT_SETTINGS, 'imperial');
  assert.equal(imperial.barWeightKg, IMPERIAL_BAR_KG);
  assert.notDeepEqual(imperial.plateInventory, DEFAULT_SETTINGS.plateInventory);

  const lattice = latticeFromSettings(imperial, 'barbell');
  // 135 lb — the first plate on each side — must be reachable.
  const target = lbToKg(135);
  assert.ok(Math.abs(lattice.snap(target) - target) < 0.05, 'a 135lb bar must be loadable');
});

test('switching back restores the metric loadout', () => {
  const there = applyUnitSystem(DEFAULT_SETTINGS, 'imperial');
  const back = applyUnitSystem(there, 'metric');
  assert.equal(back.barWeightKg, 20);
  assert.deepEqual(back.plateInventory, DEFAULT_SETTINGS.plateInventory);
});

test('switching units is a no-op when nothing changes', () => {
  assert.equal(applyUnitSystem(DEFAULT_SETTINGS, 'metric'), DEFAULT_SETTINGS);
});

test('weights display in the chosen unit but are stored in kilograms', () => {
  assert.equal(formatWeight(100, 'metric'), '100');
  assert.equal(formatWeight(100, 'imperial'), '220.5');
  assert.equal(formatWeight(62.5, 'metric'), '62.5');
});

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

test('increment is per equipment — a squat and a lateral raise do not step alike', () => {
  const barbell = schemeFromSettings(DEFAULT_SETTINGS, 'barbell');
  const band = schemeFromSettings(DEFAULT_SETTINGS, 'band');
  assert.ok(barbell.incrementKg > band.incrementKg);
});

test('turning off auto-progression stops the weight moving on its own', () => {
  const scheme = schemeFromSettings({ ...DEFAULT_SETTINGS, autoProgression: false }, 'barbell');
  assert.equal(scheme.incrementKg, 0);
});

test('unknown equipment still gets a usable increment', () => {
  const scheme = schemeFromSettings(DEFAULT_SETTINGS, 'jetpack');
  assert.ok(scheme.incrementKg > 0);
});

test('compounds rest longer than isolations', () => {
  assert.ok(
    restTargetFor(DEFAULT_SETTINGS, true) > restTargetFor(DEFAULT_SETTINGS, false),
    'three minutes after squats and after lateral raises is not the same session',
  );
});

test('a bigger bar changes which loads exist', () => {
  const light = latticeFromSettings({ ...DEFAULT_SETTINGS, barWeightKg: 15 }, 'barbell');
  const standard = latticeFromSettings(DEFAULT_SETTINGS, 'barbell');
  assert.equal(light.minKg, 15, "a women's bar starts at 15kg");
  assert.equal(standard.minKg, 20);
});

test('warm-up sets ascend, stay under the working weight, and are all loadable', () => {
  const lattice = latticeFromSettings(DEFAULT_SETTINGS, 'barbell');
  const sets = warmupSets(DEFAULT_SETTINGS, 100, lattice);

  assert.ok(sets.length > 0);
  for (const set of sets) {
    assert.ok(set.weightKg < 100, `${set.weightKg}kg is not a warm-up for 100kg`);
    assert.ok(lattice.totals.includes(set.weightKg), `${set.weightKg}kg cannot be loaded`);
    assert.ok(set.reps > 0);
  }
  for (let i = 1; i < sets.length; i++) {
    assert.ok(sets[i]!.weightKg > sets[i - 1]!.weightKg, 'warm-ups must ascend');
  }
});

test('warm-up sets that snap to the same weight collapse to one', () => {
  // A coarse machine stack makes 40% and 60% land on the same plate; showing
  // that as two identical sets just looks broken.
  const coarse = normalizeSettings({ machineStepKg: 20, warmupPercents: [40, 45, 50] });
  const lattice = latticeFromSettings(coarse, 'machine');
  const sets = warmupSets(coarse, 60, lattice);
  assert.equal(new Set(sets.map((s) => s.weightKg)).size, sets.length);
});

test('warm-ups disabled produces none', () => {
  const lattice = latticeFromSettings(DEFAULT_SETTINGS, 'barbell');
  assert.deepEqual(warmupSets({ ...DEFAULT_SETTINGS, warmupEnabled: false }, 100, lattice), []);
});

test('squad kilos are hidden by default', () => {
  // The rail shows relative intensity: four friends of different bodyweights
  // with raw numbers side by side turns training into a leaderboard.
  assert.equal(DEFAULT_SETTINGS.showAbsoluteLoads, false);
});
