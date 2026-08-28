import type { LoadType } from '../../src/domain/catalog.ts';

interface EquipmentSpec {
  loadType: LoadType;
  /** 0 machine-guided, 1 supported//fixed-path, 2 free. Feeds fatigue-matched swaps. */
  stability: 0 | 1 | 2;
  /** Base skill demand before movement pattern adjusts it. */
  skill: 0 | 1 | 2;
}

/**
 * All 28 equipment strings the dataset uses, mapped to a load type Shift can
 * reason about.
 *
 * `stability` is the axis that actually matters for swap quality: a leg press
 * and a barbell squat share a target and a pattern but demand completely
 * different stabilisation, so offering one for the other without penalty is how
 * a swap feature loses trust.
 */
export const EQUIPMENT_MAP: Record<string, EquipmentSpec> = {
  barbell: { loadType: 'barbell', stability: 2, skill: 1 },
  'olympic barbell': { loadType: 'barbell', stability: 2, skill: 2 },
  'ez barbell': { loadType: 'barbell', stability: 2, skill: 0 },
  'trap bar': { loadType: 'barbell', stability: 2, skill: 1 },
  dumbbell: { loadType: 'dumbbell', stability: 2, skill: 1 },
  kettlebell: { loadType: 'kettlebell', stability: 2, skill: 2 },
  cable: { loadType: 'cable', stability: 1, skill: 0 },
  rope: { loadType: 'cable', stability: 1, skill: 0 },
  'leverage machine': { loadType: 'machine', stability: 0, skill: 0 },
  'sled machine': { loadType: 'machine', stability: 0, skill: 0 },
  'smith machine': { loadType: 'smith', stability: 1, skill: 0 },
  band: { loadType: 'band', stability: 1, skill: 0 },
  'resistance band': { loadType: 'band', stability: 1, skill: 0 },
  'body weight': { loadType: 'bodyweight', stability: 2, skill: 0 },
  weighted: { loadType: 'bodyweight_loaded', stability: 2, skill: 1 },
  assisted: { loadType: 'assisted', stability: 1, skill: 0 },
  'stability ball': { loadType: 'other', stability: 2, skill: 1 },
  'bosu ball': { loadType: 'other', stability: 2, skill: 1 },
  'medicine ball': { loadType: 'other', stability: 2, skill: 1 },
  'wheel roller': { loadType: 'other', stability: 2, skill: 2 },
  roller: { loadType: 'other', stability: 2, skill: 1 },
  tire: { loadType: 'other', stability: 2, skill: 2 },
  hammer: { loadType: 'other', stability: 2, skill: 2 },
  // Cardio ergometers. Grouped as machines; the `cardio` pattern keeps them out
  // of strength swap candidates regardless.
  'stationary bike': { loadType: 'machine', stability: 0, skill: 0 },
  'elliptical machine': { loadType: 'machine', stability: 0, skill: 0 },
  'stepmill machine': { loadType: 'machine', stability: 0, skill: 0 },
  'skierg machine': { loadType: 'machine', stability: 0, skill: 0 },
  'upper body ergometer': { loadType: 'machine', stability: 0, skill: 0 },
};

export function canonicalEquipment(raw: string): EquipmentSpec | null {
  return EQUIPMENT_MAP[raw.trim().toLowerCase()] ?? null;
}
