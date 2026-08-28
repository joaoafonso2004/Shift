import type { CatalogExercise, SimilarityReason, SimilarityRow } from './catalog.ts';

/**
 * Biomechanical similarity between two exercises — the scoring behind
 * Swipe-to-Swap.
 *
 * The weights encode a claim: what makes an exercise a valid substitute is,
 * in order, the muscle it trains, the movement it trains it with, the supporting
 * musculature, and only then the geometry and the kit. A swap on target alone
 * would offer a barbell bench press for a cable fly.
 */
export const WEIGHTS = {
  target: 0.4,
  pattern: 0.25,
  secondary: 0.15,
  plane: 0.1,
  unilateral: 0.05,
  stability: 0.05,
} as const;

/**
 * A compound cannot substitute for an isolation. Same target, same family,
 * utterly different systemic cost — this penalty is what stops "bench press ->
 * cable fly" from ranking.
 */
export const COMPOUND_MISMATCH_PENALTY = 0.2;
/** A jump of more than one skill level is a different exercise, not a swap. */
export const SKILL_JUMP_PENALTY = 0.15;

export const DEFAULT_TOP_K = 12;

/**
 * How hard to punish a candidate for resembling one already chosen.
 *
 * Pure relevance ranking produces a top-12 that is useless in practice. Scored
 * on biomechanics alone, "barbell bench press" returns five barbell bench
 * variants and six dumbbell bench variants — every one of them scoring 1.000,
 * because a decline bench genuinely is biomechanically identical to a flat one.
 * But nobody swipes to swap a bench press for a slightly different bench press;
 * they swipe because the bench is taken.
 *
 * So selection is greedy with a redundancy penalty (maximal marginal relevance):
 * each pick is the best candidate *given what has already been picked*. The list
 * that results spans barbell, dumbbell, cable, machine and bodyweight instead of
 * enumerating one movement's variations.
 */
export const DIVERSITY_LAMBDA = 0.6;

/** Regions must be supplied by the caller — the map lives with the muscle vocabulary. */
export type RegionLookup = (muscle: CatalogExercise['target']) => string;

/**
 * Patterns that may never substitute for anything outside their own kind.
 *
 * Offering a hamstring stretch as an alternative to a squat is not a slightly
 * worse suggestion, it is a broken one, and no amount of muscle overlap should
 * be able to outvote that.
 */
const ISOLATED_PATTERNS = new Set(['stretch', 'cardio', 'neck']);

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const x of a) if (setB.has(x)) intersection++;
  return intersection / (a.length + b.length - intersection);
}

/** Word-level Jaccard on exercise names — the lexical half of redundancy. */
export function nameOverlap(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Discount applied to redundancy when two candidates use different equipment.
 *
 * Deliberately absent from `scoreSimilarity`: for *relevance*, a dumbbell press
 * is a perfectly good substitute for a barbell press, so penalising the
 * difference there would be wrong. For *redundancy* it is the opposite — needing
 * different kit is the single most useful way one alternative differs from
 * another, because the overwhelmingly common reason to swap is that the rack or
 * bench is occupied.
 */
export const DIFFERENT_KIT_DISCOUNT = 0.45;

/**
 * How little a candidate adds over one already selected.
 *
 * Three signals, because no one of them is sufficient:
 *  - biomechanical score cannot separate a flat bench from an incline bench;
 *    by every structured field they are the same movement.
 *  - name overlap catches those, but rates "cable crossover" and "cable fly" as
 *    unrelated.
 *  - load type is what a user actually cares about when the bench is taken, and
 *    it appears nowhere else in the model.
 */
export function redundancy(
  a: CatalogExercise,
  b: CatalogExercise,
  regionOf: RegionLookup,
): number {
  const biomech = scoreSimilarity(a, b, regionOf)?.score ?? 0;
  const lexical = nameOverlap(a.name, b.name);
  const base = Math.max(biomech, lexical);
  return a.loadType === b.loadType ? base : base * DIFFERENT_KIT_DISCOUNT;
}

export function scoreSimilarity(
  a: CatalogExercise,
  b: CatalogExercise,
  regionOf: RegionLookup,
): { score: number; reason: SimilarityReason } | null {
  if (a.id === b.id) return null;
  // Same movement, different camera angle or gender model. Never a swap.
  if (a.variantKey === b.variantKey) return null;

  const aIsolated = ISOLATED_PATTERNS.has(a.pattern);
  const bIsolated = ISOLATED_PATTERNS.has(b.pattern);
  if (aIsolated || bIsolated) {
    if (a.pattern !== b.pattern) return null;
  }

  const target =
    a.target === b.target ? 1 : regionOf(a.target) === regionOf(b.target) ? 0.6
    : a.bodyPart === b.bodyPart ? 0.25 : 0;

  const pattern = a.pattern === b.pattern ? 1 : a.family === b.family ? 0.5 : 0;
  if (target === 0 && pattern === 0) return null;

  const reason: SimilarityReason = {
    target,
    pattern,
    secondary: jaccard(a.secondary, b.secondary),
    plane: a.plane === b.plane ? 1 : 0,
    unilateral: a.isUnilateral === b.isUnilateral ? 1 : 0,
    stability: 1 - Math.abs(a.stability - b.stability) / 2,
  };

  let score =
    WEIGHTS.target * reason.target +
    WEIGHTS.pattern * reason.pattern +
    WEIGHTS.secondary * reason.secondary +
    WEIGHTS.plane * reason.plane +
    WEIGHTS.unilateral * reason.unilateral +
    WEIGHTS.stability * reason.stability;

  if (a.isCompound !== b.isCompound) score -= COMPOUND_MISMATCH_PENALTY;
  if (Math.abs(a.skill - b.skill) > 1) score -= SKILL_JUMP_PENALTY;

  return { score: Math.max(0, Math.round(score * 10000) / 10000), reason };
}

/**
 * Top-K neighbours for every exercise.
 *
 * Runs once at build time over ~1.75M pairs and ships as a table, so the runtime
 * cost of a swap is a single indexed lookup — the card ring can be filled
 * synchronously during mount with nothing on the gesture's critical path.
 */
export function buildSimilarityMatrix(
  exercises: readonly CatalogExercise[],
  regionOf: RegionLookup,
  topK: number = DEFAULT_TOP_K,
  lambda: number = DIVERSITY_LAMBDA,
): SimilarityRow[] {
  const rows: SimilarityRow[] = [];

  for (const a of exercises) {
    const scored: { ex: CatalogExercise; score: number; reason: SimilarityReason }[] = [];
    for (const b of exercises) {
      const result = scoreSimilarity(a, b, regionOf);
      if (result === null || result.score <= 0) continue;
      scored.push({ ex: b, score: result.score, reason: result.reason });
    }
    scored.sort((x, y) => y.score - x.score || x.ex.id.localeCompare(y.ex.id));

    // The pool must be wide enough to contain genuinely different options, not
    // just the top of one tie cluster. There are 107 compound horizontal-push
    // exercises for the chest alone, so a pool of 60 would be nothing but bench
    // press variants and diversification would have nothing to choose from.
    const pool = scored.slice(0, Math.max(topK * 15, 180));
    const selected = selectDiverse(pool, regionOf, topK, lambda);

    selected.forEach((s, rank) => {
      rows.push({ exerciseId: a.id, altId: s.ex.id, score: s.score, rank, reason: s.reason });
    });
  }

  return rows;
}

interface Scored {
  ex: CatalogExercise;
  score: number;
  reason: SimilarityReason;
}

/**
 * Greedy maximal marginal relevance. See `DIVERSITY_LAMBDA`.
 *
 * Each candidate's worst-case redundancy is carried forward and updated only
 * against the newly selected item, which keeps the pass O(K x pool) instead of
 * the O(K^2 x pool) that recomputing against every selection would cost.
 */
function selectDiverse(
  pool: readonly Scored[],
  regionOf: RegionLookup,
  topK: number,
  lambda: number,
): Scored[] {
  const remaining = [...pool];
  const worst = new Array<number>(remaining.length).fill(0);
  const selected: Scored[] = [];

  while (selected.length < topK && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const value = remaining[i]!.score - lambda * worst[i]!;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    const chosen = remaining[bestIndex]!;
    selected.push(chosen);
    remaining.splice(bestIndex, 1);
    worst.splice(bestIndex, 1);

    for (let i = 0; i < remaining.length; i++) {
      const r = redundancy(remaining[i]!.ex, chosen.ex, regionOf);
      if (r > worst[i]!) worst[i] = r;
    }
  }

  return selected;
}
