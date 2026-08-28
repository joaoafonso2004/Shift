/**
 * Shift's exercise catalog types, plus the runtime re-ranking that turns a
 * static similarity matrix into a suggestion for one specific user mid-workout.
 *
 * The build-time pipeline that produces this data lives in `scripts/catalog/`.
 * Nothing here touches the filesystem or the network — the catalog ships as a
 * prebuilt SQLite asset and is read with an indexed lookup, so a Swipe-to-Swap
 * never waits on anything (§4.4).
 */

export type CanonicalMuscle =
  | 'abs' | 'obliques' | 'spine' | 'hip_flexors'
  | 'pectorals' | 'lats' | 'upper_back' | 'traps' | 'levator_scapulae'
  | 'delts' | 'rear_delts' | 'rotator_cuff' | 'serratus_anterior'
  | 'biceps' | 'triceps' | 'forearms'
  | 'quads' | 'hamstrings' | 'glutes' | 'adductors' | 'abductors'
  | 'calves' | 'tibialis' | 'ankles'
  | 'neck' | 'cardio';

export type MovementPattern =
  | 'horizontal_push' | 'vertical_push' | 'chest_fly'
  | 'horizontal_pull' | 'vertical_pull' | 'shoulder_horizontal_abduction'
  | 'squat' | 'lunge' | 'hinge' | 'knee_extension' | 'knee_flexion' | 'hip_extension'
  | 'hip_abduction' | 'hip_adduction' | 'calf_raise'
  | 'elbow_flexion' | 'elbow_extension' | 'shoulder_abduction' | 'shrug'
  | 'wrist_flexion' | 'wrist_extension'
  | 'spinal_flexion' | 'spinal_extension' | 'lateral_flexion'
  | 'anti_extension' | 'rotation' | 'anti_rotation'
  | 'carry' | 'olympic' | 'cardio' | 'stretch' | 'neck';

/** Coarser grouping used for partial credit when patterns differ but substitute well. */
export type PatternFamily =
  | 'push_horizontal' | 'push_vertical' | 'pull_horizontal' | 'pull_vertical'
  | 'knee' | 'hip' | 'hip_frontal' | 'calf'
  | 'arm_flexion' | 'arm_extension' | 'delt' | 'trap' | 'wrist'
  | 'core_flexion' | 'core_extension' | 'core_stability' | 'core_rotation'
  | 'loaded_carry' | 'olympic' | 'cardio' | 'stretch' | 'neck';

export type LoadType =
  | 'barbell' | 'dumbbell' | 'kettlebell' | 'cable' | 'machine' | 'smith'
  | 'band' | 'bodyweight' | 'bodyweight_loaded' | 'assisted' | 'other';

export type Plane = 'sagittal' | 'frontal' | 'transverse';

/** How the movement pattern was determined — surfaced so low-confidence rows can be audited. */
export type ClassificationSource = 'rule' | 'target-fallback' | 'override';

export interface CatalogExercise {
  id: string;
  name: string;
  bodyPart: string;
  /** Raw dataset strings, kept for display and debugging. */
  rawTarget: string;
  rawEquipment: string;
  target: CanonicalMuscle;
  /** Union of canonicalised `muscle_group` and `secondary_muscles`, target removed. */
  secondary: CanonicalMuscle[];
  /**
   * Name with media-variant markers stripped ("v. 2", "(male)", "(back pov)").
   *
   * The dataset ships ~78 records that are the same movement rendered
   * differently. They are legitimate catalog rows, but offering one as an
   * alternative to another is the worst possible swap: identical exercise, new
   * card. Shared keys are excluded from each other's candidates, and the app can
   * group by this for browsing.
   */
  variantKey: string;
  pattern: MovementPattern;
  family: PatternFamily;
  plane: Plane;
  loadType: LoadType;
  isCompound: boolean;
  isUnilateral: boolean;
  /** 0 machine-guided, 1 supported, 2 free. */
  stability: 0 | 1 | 2;
  /** 0 beginner, 1 intermediate, 2 advanced. */
  skill: 0 | 1 | 2;
  classification: ClassificationSource;
  image: string | null;
  gifUrl: string | null;
  instructions: string | null;
  attribution: string;
}

export interface SimilarityReason {
  target: number;
  pattern: number;
  secondary: number;
  plane: number;
  unilateral: number;
  stability: number;
}

export interface SimilarityRow {
  exerciseId: string;
  altId: string;
  score: number;
  rank: number;
  reason: SimilarityReason;
}

// ---------------------------------------------------------------------------
// Runtime re-ranking (§5.4)
// ---------------------------------------------------------------------------

export interface RerankContext {
  /** Canonical load types the user can actually reach right now. Empty means "assume everything". */
  availableLoadTypes: readonly LoadType[];
  /** Exercise ids the user has logged before — these already have a weight prediction. */
  hasHistory: ReadonlySet<string>;
  /** Exercise ids already in today's workout. */
  inWorkout: ReadonlySet<string>;
  /** Movement patterns already trained today, for fatigue awareness. */
  patternsToday: ReadonlySet<MovementPattern>;
  /** Exercise ids the user has explicitly rejected. */
  blocked: ReadonlySet<string>;
}

export interface RankedAlternative {
  exercise: CatalogExercise;
  /** Stored similarity score, for display and debugging. Never used for ordering. */
  baseScore: number;
  finalScore: number;
  /** Position in the incoming build-time ranking. */
  rank: number;
  reason: SimilarityReason;
  /** One line for the swap card: why Shift picked this. */
  explanation: string;
}

export const EMPTY_RERANK_CONTEXT: RerankContext = {
  availableLoadTypes: [],
  hasHistory: new Set(),
  inWorkout: new Set(),
  patternsToday: new Set(),
  blocked: new Set(),
};

/**
 * How much each rank position is worth, as a fraction.
 *
 * Runtime multipliers are measured against this, so a boost has to be worth
 * roughly 4% per position to promote a candidate. A 1.25x history boost can
 * climb about six places; a 0.7x fatigue penalty drops about seven. Raise it and
 * the build-time ordering stops mattering; lower it and the runtime signals stop
 * mattering.
 */
export const RANK_DECAY = 0.04;

/**
 * Turn the static top-K neighbours into a suggestion for this user, right now.
 *
 * The static matrix is biomechanics only; it does not know which rack is free,
 * what the user already did today, or whether Shift can predict a weight for the
 * alternative. Multiplicative because these are independent filters — a missing
 * dumbbell should not be cancelled out by a good pattern match.
 *
 * **`candidates` must arrive in rank order**, and scoring starts from *rank*,
 * not from the stored similarity score. Ranking by score here would silently
 * undo the build-time diversity pass: roughly half of all similarity rows tie at
 * 1.000, so a score sort pulls the near-identical variants that MMR pushed to
 * the back of the list straight to the front again. Measured on the real
 * catalog, doing that turned a lat pulldown's diverse top five — cable, band,
 * bodyweight, machine, loaded-bodyweight — into five cable pulldowns.
 */
export function rerankAlternatives(
  candidates: readonly { exercise: CatalogExercise; score: number; reason: SimilarityReason }[],
  ctx: RerankContext = EMPTY_RERANK_CONTEXT,
): RankedAlternative[] {
  const anyEquipment = ctx.availableLoadTypes.length === 0;

  return candidates
    .map(({ exercise, score, reason }, rank) => {
      let final = Math.max(0, 1 - rank * RANK_DECAY);

      if (ctx.blocked.has(exercise.id)) final = 0;
      if (ctx.inWorkout.has(exercise.id)) final = 0;

      // Unavailable kit is heavily penalised rather than excluded: a barbell
      // suggestion is still better than nothing if the alternatives are worse.
      if (!anyEquipment && !ctx.availableLoadTypes.includes(exercise.loadType)) final *= 0.35;

      // Prefer somewhere Shift can already prefill a weight — this is what keeps
      // a swap from costing the user any typing (§7.6).
      if (ctx.hasHistory.has(exercise.id)) final *= 1.25;

      // Fatigue: same pattern already trained today is a worse substitute.
      if (ctx.patternsToday.has(exercise.pattern)) final *= 0.7;

      return {
        exercise,
        baseScore: score,
        finalScore: Math.round(final * 1000) / 1000,
        rank,
        reason,
        explanation: explainMatch(exercise, reason, ctx),
      };
    })
    .filter((c) => c.finalScore > 0)
    // Ties fall back to the incoming rank, so an untouched list comes out in
    // exactly the diversified order the build produced.
    .sort((a, b) => b.finalScore - a.finalScore || a.rank - b.rank);
}

function explainMatch(
  exercise: CatalogExercise,
  reason: SimilarityReason,
  ctx: RerankContext,
): string {
  const parts: string[] = [];
  if (reason.target >= 1) parts.push('same target muscle');
  else if (reason.target > 0) parts.push('same muscle group');
  if (reason.pattern >= 1) parts.push('same movement');
  else if (reason.pattern > 0) parts.push('similar movement');
  if (reason.stability < 1) parts.push(`${exercise.loadType.replace('_', ' ')} instead`);
  if (ctx.hasHistory.has(exercise.id)) parts.push('you have history here');
  return parts.length > 0 ? capitalise(parts.join(', ')) : 'Closest available match';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Turn arbitrary user input into a safe FTS5 prefix query.
 *
 * FTS5 treats `"`, `*`, `(`, `-`, `^`, `:` and the bare words `AND`/`OR`/`NOT`/
 * `NEAR` as syntax, so passing a search box straight through throws on
 * characters people type constantly — an apostrophe in "farmer's walk", a hyphen
 * in "pull-up". Tokens are reduced to alphanumerics and each gets a prefix
 * wildcard, which is also what makes search feel live as the user types.
 *
 * Returns null when nothing searchable remains, so callers can skip the query
 * rather than issuing one that matches everything.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(' ');
}
