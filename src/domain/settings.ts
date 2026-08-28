import type { LoadType } from './catalog.ts';
import { buildBarbellLattice, buildFixedIncrementLattice, type LoadLattice, type PlateInventory } from './plates.ts';
import type { ProgressionScheme } from './progression.ts';
import type { AccentName, SurfaceName } from './theme.ts';

/**
 * User settings.
 *
 * The rule applied throughout: **a setting has to change behaviour.** Anything
 * that would only be a toggle with no consequence is left out. Almost every
 * field here feeds something already built — the plate lattice, the progression
 * ladder, the haptic gate, the swap re-rank — which is why the derivations at
 * the bottom of this file matter more than the schema at the top.
 */

export type UnitSystem = 'metric' | 'imperial';
export type WeekStart = 'monday' | 'sunday' | 'saturday';
export type SurfacePreference = SurfaceName | 'system';

export interface Settings {
  // Appearance
  surface: SurfacePreference;
  accent: AccentName;
  /** Overrides the OS setting when true; the OS still wins when it asks for less. */
  reduceMotion: boolean;
  /** 0 off, 1 light, 2 standard, 3 intense. Feeds HapticGate directly. */
  hapticIntensity: 0 | 1 | 2 | 3;

  // Units and equipment — these change what loads exist, not just labels
  unitSystem: UnitSystem;
  barWeightKg: number;
  plateInventory: PlateInventory;
  dumbbellStepKg: number;
  dumbbellMaxKg: number;
  machineStepKg: number;
  availableEquipment: LoadType[];

  // Workout
  /** Rest after a compound lift. Separate because 3 minutes after squats and
   *  3 minutes after lateral raises are not the same session. */
  restCompoundS: number;
  restIsolationS: number;
  restAutoStart: boolean;
  /** Seconds before the timer ends to give a heads-up. 0 disables it. */
  restAlertS: number;
  keepScreenAwake: boolean;
  trackRpe: boolean;
  warmupEnabled: boolean;
  /** Percentages of the working weight, ascending. */
  warmupPercents: number[];

  // Progression
  autoProgression: boolean;
  repRangeMin: number;
  repRangeMax: number;
  /** Per load type: a squat and a lateral raise do not progress in the same step. */
  incrementKg: Record<string, number>;
  deloadAfterFailures: number;
  deloadFraction: number;

  // Squad
  /** Off by default — see §6.3 on why the rail shows relative intensity. */
  showAbsoluteLoads: boolean;
  squadHaptics: boolean;

  // Data
  weekStartsOn: WeekStart;
  syncOnCellular: boolean;
}

/** Standard commercial-gym metric loadout. */
export const METRIC_PLATES: PlateInventory = {
  '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2,
};

/** US plates, expressed in kg because all internal mass is metric (§ units.ts). */
export const IMPERIAL_PLATES: PlateInventory = {
  '20.41': 4, // 45 lb
  '15.88': 2, // 35 lb
  '11.34': 4, // 25 lb
  '4.54': 4, //  10 lb
  '2.27': 4, //   5 lb
  '1.13': 2, // 2.5 lb
};

export const IMPERIAL_BAR_KG = 20.41; // 45 lb

export const DEFAULT_SETTINGS: Settings = {
  surface: 'system',
  accent: 'blue',
  reduceMotion: false,
  hapticIntensity: 2,

  unitSystem: 'metric',
  barWeightKg: 20,
  plateInventory: METRIC_PLATES,
  dumbbellStepKg: 2,
  dumbbellMaxKg: 60,
  machineStepKg: 5,
  availableEquipment: [],

  restCompoundS: 180,
  restIsolationS: 90,
  restAutoStart: true,
  restAlertS: 10,
  keepScreenAwake: true,
  trackRpe: false,
  warmupEnabled: true,
  warmupPercents: [40, 60, 80],

  autoProgression: true,
  repRangeMin: 8,
  repRangeMax: 12,
  incrementKg: {
    // Lower-body compounds tolerate bigger jumps than a rear-delt raise ever will.
    barbell: 2.5,
    smith: 2.5,
    dumbbell: 2,
    kettlebell: 4,
    cable: 2.5,
    machine: 5,
    band: 1,
    bodyweight: 1.25,
    bodyweight_loaded: 1.25,
    assisted: 2.5,
    other: 1.25,
  },
  deloadAfterFailures: 2,
  deloadFraction: 0.9,

  showAbsoluteLoads: false,
  squadHaptics: true,

  weekStartsOn: 'monday',
  syncOnCellular: true,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Repair a settings object read from storage.
 *
 * Settings survive app updates, so a field can arrive missing, stale, or
 * nonsensical. Everything is clamped into a range that still produces a working
 * app: a rep range of 12–8 or a bar weighing zero must not be able to brick the
 * plate solver.
 */
export function normalizeSettings(input: Partial<Settings> | null | undefined): Settings {
  const raw = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

  const repRangeMin = clamp(raw.repRangeMin, 1, 30, DEFAULT_SETTINGS.repRangeMin);
  const repRangeMax = clamp(raw.repRangeMax, repRangeMin, 50, DEFAULT_SETTINGS.repRangeMax);

  return {
    ...raw,
    hapticIntensity: clamp(raw.hapticIntensity, 0, 3, 2) as 0 | 1 | 2 | 3,
    barWeightKg: clamp(raw.barWeightKg, 1, 60, DEFAULT_SETTINGS.barWeightKg),
    dumbbellStepKg: clamp(raw.dumbbellStepKg, 0.5, 10, DEFAULT_SETTINGS.dumbbellStepKg),
    dumbbellMaxKg: clamp(raw.dumbbellMaxKg, 10, 200, DEFAULT_SETTINGS.dumbbellMaxKg),
    machineStepKg: clamp(raw.machineStepKg, 1, 25, DEFAULT_SETTINGS.machineStepKg),
    restCompoundS: clamp(raw.restCompoundS, 15, 600, DEFAULT_SETTINGS.restCompoundS),
    restIsolationS: clamp(raw.restIsolationS, 15, 600, DEFAULT_SETTINGS.restIsolationS),
    restAlertS: clamp(raw.restAlertS, 0, 60, DEFAULT_SETTINGS.restAlertS),
    repRangeMin,
    repRangeMax,
    deloadAfterFailures: clamp(raw.deloadAfterFailures, 1, 10, DEFAULT_SETTINGS.deloadAfterFailures),
    deloadFraction: clamp(raw.deloadFraction, 0.5, 0.99, DEFAULT_SETTINGS.deloadFraction),
    warmupPercents: (Array.isArray(raw.warmupPercents) ? raw.warmupPercents : [])
      .filter((p) => Number.isFinite(p) && p > 0 && p < 100)
      .sort((a, b) => a - b)
      .slice(0, 5),
    plateInventory:
      raw.plateInventory && Object.keys(raw.plateInventory).length > 0
        ? raw.plateInventory
        : DEFAULT_SETTINGS.plateInventory,
    incrementKg: { ...DEFAULT_SETTINGS.incrementKg, ...(raw.incrementKg ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const LB_PER_KG = 2.20462262;

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}

/**
 * Display a stored kilogram value in the user's units.
 *
 * Storage is always metric (invariant #16), so switching units is a presentation
 * change and can never round-trip a logged weight into a slightly different one.
 */
export function formatWeight(kg: number, unitSystem: UnitSystem, decimals = 1): string {
  const value = unitSystem === 'imperial' ? kgToLb(kg) : kg;
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
  return `${rounded}`.replace(/\.0+$/, '');
}

export function unitLabel(unitSystem: UnitSystem): string {
  return unitSystem === 'imperial' ? 'lb' : 'kg';
}

// ---------------------------------------------------------------------------
// Derivations — where settings stop being data and start being behaviour
// ---------------------------------------------------------------------------

/** The loads a given piece of equipment can express, under these settings. */
export function latticeFromSettings(settings: Settings, loadType: string): LoadLattice {
  switch (loadType) {
    case 'barbell':
    case 'smith':
      return buildBarbellLattice(
        { barWeightKg: settings.barWeightKg, minIncrementKg: 1.25 },
        settings.plateInventory,
      );
    case 'dumbbell':
    case 'kettlebell':
      return buildFixedIncrementLattice({
        minKg: settings.dumbbellStepKg,
        maxKg: settings.dumbbellMaxKg,
        stepKg: settings.dumbbellStepKg,
      });
    case 'cable':
    case 'machine':
    case 'assisted':
      return buildFixedIncrementLattice({
        minKg: settings.machineStepKg,
        maxKg: settings.machineStepKg * 30,
        stepKg: settings.machineStepKg,
      });
    default:
      return buildFixedIncrementLattice({ minKg: 0, maxKg: 60, stepKg: 1.25 });
  }
}

/** The progression ladder for one exercise, under these settings. */
export function schemeFromSettings(
  settings: Settings,
  loadType: string,
  targetSets = 3,
): ProgressionScheme {
  return {
    repRange: [settings.repRangeMin, settings.repRangeMax],
    targetSets,
    incrementKg: settings.autoProgression
      ? (settings.incrementKg[loadType] ?? DEFAULT_SETTINGS.incrementKg.barbell!)
      : 0,
    deloadAfterFailures: settings.deloadAfterFailures,
    deloadFraction: settings.deloadFraction,
  };
}

/** Rest target for an exercise, by whether it is a compound. */
export function restTargetFor(settings: Settings, isCompound: boolean): number {
  return isCompound ? settings.restCompoundS : settings.restIsolationS;
}

/** Warm-up sets leading into a working weight, snapped to loadable values. */
export function warmupSets(
  settings: Settings,
  workingKg: number,
  lattice: LoadLattice,
): { weightKg: number; reps: number }[] {
  if (!settings.warmupEnabled || settings.warmupPercents.length === 0) return [];

  const out: { weightKg: number; reps: number }[] = [];
  let previous = -1;

  for (const percent of settings.warmupPercents) {
    const snapped = lattice.snap((workingKg * percent) / 100);
    // Two percentages can snap to the same loadable weight on a coarse machine
    // stack; showing that as two identical sets would just look broken.
    if (snapped === previous || snapped >= workingKg) continue;
    previous = snapped;
    out.push({
      weightKg: snapped,
      reps: percent < 50 ? 10 : percent < 70 ? 6 : 3,
    });
  }

  return out;
}

/** Applying an imperial loadout is a real equipment change, not a label swap. */
export function applyUnitSystem(settings: Settings, unitSystem: UnitSystem): Settings {
  if (unitSystem === settings.unitSystem) return settings;
  return {
    ...settings,
    unitSystem,
    barWeightKg: unitSystem === 'imperial' ? IMPERIAL_BAR_KG : 20,
    plateInventory: unitSystem === 'imperial' ? IMPERIAL_PLATES : METRIC_PLATES,
    dumbbellStepKg: unitSystem === 'imperial' ? lbToKg(5) : 2,
    machineStepKg: unitSystem === 'imperial' ? lbToKg(10) : 5,
  };
}
