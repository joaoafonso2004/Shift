import type { CanonicalMuscle } from '../../src/domain/catalog.ts';

/**
 * Hand-audited map from every muscle string the dataset actually uses to Shift's
 * canonical vocabulary.
 *
 * The dataset's schema declares no enum for `target`, `muscle_group`, or
 * `secondary_muscles`, and the values alias heavily across the three fields:
 * `traps`/`trapezius`, `lats`/`latissimus dorsi`, `quads`/`quadriceps`,
 * `delts`/`deltoids`/`shoulders`, `abs`/`abdominals`. Similarity scoring is
 * meaningless until they agree.
 *
 * The 50 keys below are the exact union observed across all 1,324 records. The
 * build fails on any unmapped string rather than silently dropping it — a new
 * muscle appearing upstream must be a human decision, because one wrong mapping
 * produces a visibly stupid swap suggestion.
 */
export const MUSCLE_MAP: Record<string, CanonicalMuscle> = {
  // core
  abs: 'abs',
  abdominals: 'abs',
  'lower abs': 'abs',
  core: 'abs',
  obliques: 'obliques',
  spine: 'spine',
  'lower back': 'spine',
  'hip flexors': 'hip_flexors',

  // chest / back
  pectorals: 'pectorals',
  chest: 'pectorals',
  'upper chest': 'pectorals',
  lats: 'lats',
  'latissimus dorsi': 'lats',
  'upper back': 'upper_back',
  back: 'upper_back',
  rhomboids: 'upper_back',
  traps: 'traps',
  trapezius: 'traps',
  'levator scapulae': 'levator_scapulae',
  'serratus anterior': 'serratus_anterior',

  // shoulders
  delts: 'delts',
  deltoids: 'delts',
  shoulders: 'delts',
  'rear deltoids': 'rear_delts',
  'rotator cuff': 'rotator_cuff',

  // arms
  biceps: 'biceps',
  brachialis: 'biceps',
  triceps: 'triceps',
  forearms: 'forearms',
  'wrist flexors': 'forearms',
  'wrist extensors': 'forearms',
  wrists: 'forearms',
  'grip muscles': 'forearms',
  hands: 'forearms',

  // legs
  quads: 'quads',
  quadriceps: 'quads',
  hamstrings: 'hamstrings',
  glutes: 'glutes',
  adductors: 'adductors',
  'inner thighs': 'adductors',
  groin: 'adductors',
  abductors: 'abductors',
  calves: 'calves',
  soleus: 'calves',
  shins: 'tibialis',
  ankles: 'ankles',
  'ankle stabilizers': 'ankles',
  feet: 'ankles',

  // other
  sternocleidomastoid: 'neck',
  'cardiovascular system': 'cardio',
};

/**
 * Coarse region per canonical muscle.
 *
 * Used for the partial-credit tier in similarity scoring: an exact target match
 * scores full, a different muscle in the same region scores some, and anything
 * else scores nothing. Without this, "same body_part" would be the only fallback
 * and `upper arms` would rate biceps and triceps as interchangeable.
 */
export type MuscleRegion =
  | 'core' | 'chest' | 'back' | 'shoulder' | 'arm_front' | 'arm_back' | 'forearm'
  | 'thigh_front' | 'thigh_back' | 'hip' | 'lower_leg' | 'neck' | 'systemic';

export const MUSCLE_REGION: Record<CanonicalMuscle, MuscleRegion> = {
  abs: 'core',
  obliques: 'core',
  spine: 'core',
  hip_flexors: 'core',
  pectorals: 'chest',
  serratus_anterior: 'chest',
  lats: 'back',
  upper_back: 'back',
  traps: 'back',
  levator_scapulae: 'back',
  delts: 'shoulder',
  rear_delts: 'shoulder',
  rotator_cuff: 'shoulder',
  biceps: 'arm_front',
  triceps: 'arm_back',
  forearms: 'forearm',
  quads: 'thigh_front',
  hamstrings: 'thigh_back',
  glutes: 'hip',
  adductors: 'hip',
  abductors: 'hip',
  calves: 'lower_leg',
  tibialis: 'lower_leg',
  ankles: 'lower_leg',
  neck: 'neck',
  cardio: 'systemic',
};

export function canonicalMuscle(raw: string): CanonicalMuscle | null {
  return MUSCLE_MAP[raw.trim().toLowerCase()] ?? null;
}
