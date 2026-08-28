import type {
  CanonicalMuscle,
  MovementPattern,
  PatternFamily,
  Plane,
} from '../../src/domain/catalog.ts';

/**
 * Movement-pattern classification.
 *
 * The dataset has no biomechanical fields at all — no pattern, no plane, no
 * joint action, no compound flag. Without them a swap on `target` alone would
 * offer a barbell bench press as an alternative to a cable fly: same muscle,
 * completely different demand. Deriving these is the feature, not preprocessing.
 *
 * Rules are ordered most-specific first and match on the exercise name combined
 * with its canonical target, because neither alone is sufficient: "curl" means
 * elbow flexion with target biceps and knee flexion with target hamstrings.
 */

export interface ClassifyInput {
  name: string;
  target: CanonicalMuscle;
  bodyPart: string;
}

interface Rule {
  pattern: MovementPattern;
  match: (name: string, target: CanonicalMuscle) => boolean;
}

const has = (name: string, ...words: string[]): boolean =>
  words.some((w) => new RegExp(`\\b${w}\\b`).test(name));

const RULES: Rule[] = [
  // Mobility work must never enter the strength swap pool, so it is matched first.
  { pattern: 'stretch', match: (n) => has(n, 'stretch', 'mobility') },
  { pattern: 'cardio', match: (n, t) => t === 'cardio' || has(n, 'run', 'cycle', 'ergometer') },
  { pattern: 'neck', match: (n, t) => t === 'neck' || t === 'levator_scapulae' },

  { pattern: 'olympic', match: (n) => has(n, 'clean', 'snatch', 'jerk') },
  { pattern: 'carry', match: (n) => has(n, 'carry', 'carries', 'farmer') },

  // Anchored before the generic curl/raise/press rules that would otherwise win.
  { pattern: 'calf_raise', match: (n, t) => has(n, 'calf') || t === 'calves' || t === 'tibialis' },
  { pattern: 'shrug', match: (n) => has(n, 'shrug', 'shrugs') },
  { pattern: 'wrist_extension', match: (n) => has(n, 'wrist') && has(n, 'reverse', 'extension') },
  { pattern: 'wrist_flexion', match: (n) => has(n, 'wrist') },

  // "curl" is ambiguous: elbow flexion or knee flexion depending on the target.
  { pattern: 'knee_flexion', match: (n, t) => has(n, 'curl') && t === 'hamstrings' },
  { pattern: 'knee_flexion', match: (n) => has(n, 'leg') && has(n, 'curl') },
  { pattern: 'knee_extension', match: (n) => has(n, 'leg') && has(n, 'extension') },
  { pattern: 'elbow_flexion', match: (n, t) => has(n, 'curl') && t === 'biceps' },

  { pattern: 'hip_abduction', match: (n) => has(n, 'abduction', 'abductor') },
  { pattern: 'hip_adduction', match: (n) => has(n, 'adduction', 'adductor') },
  // Rack pulls and pull-throughs are hinges. Both contain "pull" and would
  // otherwise be swept up by the vertical-pull or hip-extension rules.
  { pattern: 'hinge', match: (n) => has(n, 'rack') && has(n, 'pull') },
  { pattern: 'hinge', match: (n) => has(n, 'pull') && has(n, 'through') },
  { pattern: 'hip_extension', match: (n) => has(n, 'thrust', 'bridge') },

  { pattern: 'anti_rotation', match: (n) => has(n, 'pallof') },
  { pattern: 'rotation', match: (n) => has(n, 'twist', 'twisting', 'windmill', 'woodchop', 'rotation') },
  // "rollerout" is the dataset's spelling; without it these fell through to
  // spinal_flexion, and "barbell rollerout from bench" reached horizontal_push.
  { pattern: 'anti_extension', match: (n) => has(n, 'plank', 'fallout', 'rollout', 'rollerout', 'roll-out', 'hollow', 'wheel') },
  { pattern: 'spinal_extension', match: (n, t) => has(n, 'hyperextension') || (has(n, 'extension') && t === 'spine') },
  // Side bends are frontal-plane lateral flexion, not a crunch — different plane,
  // different substitutes.
  { pattern: 'lateral_flexion', match: (n) => has(n, 'side') && has(n, 'bend', 'bends') },
  { pattern: 'spinal_flexion', match: (n) => has(n, 'crunch', 'sit-up', 'situp', 'pike') },
  { pattern: 'spinal_flexion', match: (n, t) => has(n, 'raise') && (t === 'abs' || t === 'hip_flexors') },

  // Row and fly variants split by target before the generic rules.
  { pattern: 'shoulder_abduction', match: (n) => has(n, 'upright') && has(n, 'row') },
  { pattern: 'shoulder_horizontal_abduction', match: (n) => has(n, 'reverse') && has(n, 'fly', 'flye') },
  { pattern: 'shoulder_horizontal_abduction', match: (n, t) => has(n, 'row', 'fly', 'flye', 'raise') && t === 'rear_delts' },
  { pattern: 'shoulder_horizontal_abduction', match: (n) => has(n, 'rear') && has(n, 'delt', 'deltoid') },
  { pattern: 'horizontal_pull', match: (n) => has(n, 'row') },

  { pattern: 'vertical_pull', match: (n) => has(n, 'pulldown', 'pull-up', 'pullup', 'chin-up', 'chinup', 'pullover') },
  { pattern: 'vertical_pull', match: (n) => has(n, 'pull') && has(n, 'down', 'up') },

  { pattern: 'chest_fly', match: (n, t) => has(n, 'fly', 'flye') && t === 'pectorals' },
  { pattern: 'chest_fly', match: (n) => has(n, 'pec') && has(n, 'deck') },

  { pattern: 'shoulder_abduction', match: (n, t) => has(n, 'raise') && (t === 'delts' || t === 'traps') },
  { pattern: 'shoulder_abduction', match: (n) => has(n, 'lateral', 'front') && has(n, 'raise') },

  { pattern: 'vertical_push', match: (n) => has(n, 'overhead', 'military', 'arnold') },
  { pattern: 'vertical_push', match: (n, t) => has(n, 'press') && (t === 'delts' || t === 'serratus_anterior') },
  { pattern: 'vertical_push', match: (n, t) => has(n, 'dip', 'dips') && t !== 'triceps' },

  { pattern: 'elbow_extension', match: (n, t) => t === 'triceps' },

  { pattern: 'lunge', match: (n) => has(n, 'lunge', 'step-up', 'stepup') },
  { pattern: 'lunge', match: (n) => has(n, 'split', 'bulgarian') && has(n, 'squat') },
  { pattern: 'squat', match: (n) => has(n, 'squat') },
  { pattern: 'hinge', match: (n) => has(n, 'deadlift', 'romanian', 'rdl') },
  { pattern: 'hinge', match: (n) => has(n, 'good') && has(n, 'morning') },

  { pattern: 'horizontal_push', match: (n) => has(n, 'push-up', 'pushup', 'bench') },
  { pattern: 'horizontal_push', match: (n, t) => has(n, 'press', 'push') && t === 'pectorals' },
];

/**
 * Fallback by target when no name rule fires.
 *
 * Marked separately from rule matches so coverage can be measured honestly and
 * the weakest rows audited first — a target fallback is a guess about the
 * movement, not a reading of it.
 */
const TARGET_FALLBACK: Record<CanonicalMuscle, MovementPattern> = {
  pectorals: 'horizontal_push',
  serratus_anterior: 'vertical_push',
  lats: 'vertical_pull',
  upper_back: 'horizontal_pull',
  traps: 'shrug',
  levator_scapulae: 'neck',
  delts: 'shoulder_abduction',
  rear_delts: 'shoulder_horizontal_abduction',
  rotator_cuff: 'shoulder_horizontal_abduction',
  biceps: 'elbow_flexion',
  triceps: 'elbow_extension',
  forearms: 'wrist_flexion',
  quads: 'squat',
  hamstrings: 'knee_flexion',
  glutes: 'hip_extension',
  adductors: 'hip_adduction',
  abductors: 'hip_abduction',
  calves: 'calf_raise',
  tibialis: 'calf_raise',
  ankles: 'calf_raise',
  abs: 'spinal_flexion',
  obliques: 'rotation',
  spine: 'spinal_extension',
  hip_flexors: 'spinal_flexion',
  neck: 'neck',
  cardio: 'cardio',
};

export interface Classification {
  pattern: MovementPattern;
  source: 'rule' | 'target-fallback';
}

export function classifyPattern(input: ClassifyInput): Classification {
  const name = input.name.toLowerCase();
  for (const rule of RULES) {
    if (rule.match(name, input.target)) return { pattern: rule.pattern, source: 'rule' };
  }
  return { pattern: TARGET_FALLBACK[input.target], source: 'target-fallback' };
}

export const PATTERN_FAMILY: Record<MovementPattern, PatternFamily> = {
  horizontal_push: 'push_horizontal',
  chest_fly: 'push_horizontal',
  vertical_push: 'push_vertical',
  horizontal_pull: 'pull_horizontal',
  shoulder_horizontal_abduction: 'pull_horizontal',
  vertical_pull: 'pull_vertical',
  squat: 'knee',
  lunge: 'knee',
  knee_extension: 'knee',
  hinge: 'hip',
  hip_extension: 'hip',
  knee_flexion: 'hip',
  hip_abduction: 'hip_frontal',
  hip_adduction: 'hip_frontal',
  calf_raise: 'calf',
  elbow_flexion: 'arm_flexion',
  elbow_extension: 'arm_extension',
  shoulder_abduction: 'delt',
  shrug: 'trap',
  wrist_flexion: 'wrist',
  wrist_extension: 'wrist',
  spinal_flexion: 'core_flexion',
  spinal_extension: 'core_extension',
  lateral_flexion: 'core_rotation',
  anti_extension: 'core_stability',
  anti_rotation: 'core_stability',
  rotation: 'core_rotation',
  carry: 'loaded_carry',
  olympic: 'olympic',
  cardio: 'cardio',
  stretch: 'stretch',
  neck: 'neck',
};

export const PATTERN_PLANE: Record<MovementPattern, Plane> = {
  horizontal_push: 'transverse',
  chest_fly: 'transverse',
  horizontal_pull: 'transverse',
  shoulder_horizontal_abduction: 'transverse',
  rotation: 'transverse',
  anti_rotation: 'transverse',
  vertical_pull: 'frontal',
  shoulder_abduction: 'frontal',
  hip_abduction: 'frontal',
  hip_adduction: 'frontal',
  lateral_flexion: 'frontal',
  vertical_push: 'sagittal',
  squat: 'sagittal',
  lunge: 'sagittal',
  hinge: 'sagittal',
  knee_extension: 'sagittal',
  knee_flexion: 'sagittal',
  hip_extension: 'sagittal',
  calf_raise: 'sagittal',
  elbow_flexion: 'sagittal',
  elbow_extension: 'sagittal',
  shrug: 'sagittal',
  wrist_flexion: 'sagittal',
  wrist_extension: 'sagittal',
  spinal_flexion: 'sagittal',
  spinal_extension: 'sagittal',
  anti_extension: 'sagittal',
  carry: 'sagittal',
  olympic: 'sagittal',
  cardio: 'sagittal',
  stretch: 'sagittal',
  neck: 'sagittal',
};

const COMPOUND_PATTERNS = new Set<MovementPattern>([
  'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull',
  'squat', 'lunge', 'hinge', 'hip_extension', 'olympic', 'carry',
]);

export function isCompound(pattern: MovementPattern, secondaryCount: number): boolean {
  return COMPOUND_PATTERNS.has(pattern) || secondaryCount >= 3;
}

const UNILATERAL = /\b(single|one[- ]?arm|one[- ]?leg|one arm|one leg|alternat\w*|unilateral)\b/;

export function isUnilateral(name: string): boolean {
  return UNILATERAL.test(name.toLowerCase());
}

/** Advanced patterns raise the equipment's base skill demand. */
export function skillFor(pattern: MovementPattern, equipmentSkill: 0 | 1 | 2): 0 | 1 | 2 {
  if (pattern === 'olympic') return 2;
  if (pattern === 'stretch' || pattern === 'cardio') return 0;
  return equipmentSkill;
}
