import type { LoadLattice } from './plates.ts';

/**
 * Shift's progression predictor.
 *
 * This is what makes lazy logging work: by the time a set renders, its weight
 * and rep target are already filled in, so finishing a set is one tap instead of
 * two number entries. Everything here is pure and deterministic — `now` is
 * injected rather than read, so a prediction is reproducible and testable.
 */

export interface SetRecord {
  setIndex: number;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  isWarmup: boolean;
  /** ISO 8601. */
  completedAt: string;
}

export interface SessionRecord {
  /** ISO 8601. */
  at: string;
  sets: SetRecord[];
}

/** Mirrors the `exercise_progression` row the SQL trigger maintains (§2.2). */
export interface ProgressionState {
  exerciseId: string;
  lastSessionAt: string | null;
  lastSets: SetRecord[];
  bestE1rm: number | null;
  bestE1rmAt: string | null;
  sessionCount: number;
  trendKgPerSession: number | null;
  /**
   * Sessions in a row that fell short of the rep target.
   *
   * Not derivable from `lastSets` alone, which is why it is a stored column
   * rather than something the client recomputes: deciding between "retry" and
   * "deload" needs memory further back than one session.
   */
  consecutiveFailures: number;
}

export interface ProgressionScheme {
  /** Double progression: work up within the range, then add weight and reset. */
  repRange: [number, number];
  targetSets: number;
  incrementKg: number;
  deloadAfterFailures: number;
  deloadFraction: number;
}

export interface DetrainingModel {
  /** Days off before any decay applies. */
  graceDays: number;
  /** Fraction of estimated strength lost per week beyond the grace period. */
  weeklyDecay: number;
  /** Decay never goes below this fraction of the last known load. */
  floor: number;
}

export const DEFAULT_SCHEME: ProgressionScheme = {
  repRange: [8, 12],
  targetSets: 3,
  incrementKg: 2.5,
  deloadAfterFailures: 2,
  deloadFraction: 0.9,
};

/**
 * Placeholder constants, same status as the plate transition model: they are
 * plausible rather than measured, and should be calibrated once real return-
 * from-layoff sessions exist.
 */
export const DEFAULT_DETRAINING: DetrainingModel = {
  graceDays: 14,
  weeklyDecay: 0.025,
  floor: 0.7,
};

export type Confidence = 'none' | 'low' | 'medium' | 'high';
export type PredictionSource = 'progression' | 'repeat' | 'deload' | 'transfer' | 'default';

export interface PredictedSet {
  setIndex: number;
  weightKg: number;
  reps: number;
  isTopSet: boolean;
}

export interface Prediction {
  sets: PredictedSet[];
  confidence: Confidence;
  source: PredictionSource;
  /** One line, shown under the prefilled numbers so the suggestion is never a black box. */
  rationale: string;
  impliedE1rm: number | null;
  /** Top-set load over best e1RM — the non-comparative metric the squad rail displays (§6.3). */
  relativeIntensity: number | null;
}

// ---------------------------------------------------------------------------
// One-rep-max estimation
// ---------------------------------------------------------------------------

/**
 * Epley's formula caps at 12 reps here to match the `sets.e1rm` generated
 * column exactly. Beyond ~12 the estimate degrades badly, and a client that
 * disagreed with the database about a PR would be worse than no estimate.
 */
export const E1RM_MAX_REPS = 12;

export function epleyE1rm(weightKg: number | null, reps: number | null): number | null {
  if (weightKg === null || reps === null) return null;
  if (weightKg <= 0 || reps < 1 || reps > E1RM_MAX_REPS) return null;
  return round2(weightKg * (1 + reps / 30));
}

/** Inverse Epley: the load that should yield `reps` at a given e1RM. */
export function weightForReps(e1rm: number, reps: number): number {
  return round2(e1rm / (1 + reps / 30));
}

// ---------------------------------------------------------------------------
// Building state from history
// ---------------------------------------------------------------------------

export function workingSets(sets: readonly SetRecord[]): SetRecord[] {
  return sets.filter((s) => !s.isWarmup && s.weightKg !== null && s.reps !== null);
}

function hitTarget(sets: readonly SetRecord[], scheme: ProgressionScheme): boolean {
  const working = workingSets(sets);
  if (working.length === 0) return false;
  return working.every((s) => (s.reps ?? 0) >= scheme.repRange[0]);
}

/**
 * Derive `exercise_progression` from raw history.
 *
 * This is the reference implementation of what the `after insert on sets`
 * trigger must compute. Keeping it here in testable TypeScript means the SQL can
 * be checked against it rather than trusted.
 */
export function buildProgressionState(
  exerciseId: string,
  sessions: readonly SessionRecord[],
  scheme: ProgressionScheme = DEFAULT_SCHEME,
): ProgressionState {
  const ordered = [...sessions]
    .filter((s) => workingSets(s.sets).length > 0)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (ordered.length === 0) {
    return {
      exerciseId,
      lastSessionAt: null,
      lastSets: [],
      bestE1rm: null,
      bestE1rmAt: null,
      sessionCount: 0,
      trendKgPerSession: null,
      consecutiveFailures: 0,
    };
  }

  let bestE1rm: number | null = null;
  let bestE1rmAt: string | null = null;
  const perSessionBest: number[] = [];

  for (const session of ordered) {
    let sessionBest: number | null = null;
    for (const s of workingSets(session.sets)) {
      const e = epleyE1rm(s.weightKg, s.reps);
      if (e === null) continue;
      if (sessionBest === null || e > sessionBest) sessionBest = e;
      if (bestE1rm === null || e > bestE1rm) {
        bestE1rm = e;
        bestE1rmAt = s.completedAt;
      }
    }
    if (sessionBest !== null) perSessionBest.push(sessionBest);
  }

  let consecutiveFailures = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTarget(ordered[i]!.sets, scheme)) break;
    consecutiveFailures++;
  }

  const last = ordered[ordered.length - 1]!;
  return {
    exerciseId,
    lastSessionAt: last.at,
    lastSets: workingSets(last.sets),
    bestE1rm,
    bestE1rmAt,
    sessionCount: ordered.length,
    trendKgPerSession: theilSenSlope(perSessionBest),
    consecutiveFailures,
  };
}

/**
 * Theil-Sen: the median of all pairwise slopes.
 *
 * Least squares is the obvious choice and it is the wrong one for gym data. A
 * single deload week, a session cut short by a busy rack, or one heavy single
 * drags an ordinary regression line hard enough to change next week's
 * prescription. Theil-Sen ignores up to ~29% of the points being garbage, which
 * is roughly what real training logs look like.
 */
export function theilSenSlope(ys: readonly number[]): number | null {
  if (ys.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      slopes.push((ys[j]! - ys[i]!) / (j - i));
    }
  }
  return round2(median(slopes));
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export interface TransferSource {
  fromExerciseId: string;
  state: ProgressionState;
  /**
   * Load ratio between the source lift and the target. Supplied by the caller —
   * it belongs to the exercise catalog, not to this module, and inventing a
   * number here would be worse than requiring one.
   */
  ratio: number;
  label?: string;
}

export interface PredictInput {
  state: ProgressionState;
  /** ISO 8601. Injected, never read from the clock, so predictions are reproducible. */
  now: string;
  scheme?: ProgressionScheme;
  lattice?: LoadLattice;
  detraining?: DetrainingModel;
  transfer?: TransferSource;
  /** Used only when there is no history and no transfer source. */
  fallbackKg?: number;
}

export function predictNextSession(input: PredictInput): Prediction {
  const scheme = input.scheme ?? DEFAULT_SCHEME;
  const detraining = input.detraining ?? DEFAULT_DETRAINING;
  const snap = (kg: number) => (input.lattice ? input.lattice.snap(kg) : round2(kg));
  const { state } = input;

  if (state.sessionCount === 0 || workingSets(state.lastSets).length === 0) {
    return coldStart(input, scheme, snap);
  }

  const last = workingSets(state.lastSets);
  const lastTop = Math.max(...last.map((s) => s.weightKg!));
  const lastTopReps = Math.max(...last.filter((s) => s.weightKg === lastTop).map((s) => s.reps!));
  const shape = inferSetShape(last, scheme.targetSets);

  const decay = detrainingFactor(state.lastSessionAt, input.now, detraining);
  const stalled = state.trendKgPerSession !== null && state.trendKgPerSession < 0;

  let topKg: number;
  let reps: number;
  let source: PredictionSource;
  let rationale: string;

  if (state.consecutiveFailures >= scheme.deloadAfterFailures) {
    topKg = lastTop * scheme.deloadFraction;
    reps = scheme.repRange[0];
    source = 'deload';
    rationale = `${state.consecutiveFailures} sessions short of ${scheme.repRange[0]} reps — backing off to rebuild.`;
  } else if (state.consecutiveFailures > 0) {
    topKg = lastTop;
    reps = Math.max(lastTopReps, scheme.repRange[0]);
    source = 'repeat';
    rationale = `Came up short last time — same weight, same target.`;
  } else if (lastTopReps >= scheme.repRange[1] && !stalled) {
    topKg = lastTop + scheme.incrementKg;
    reps = scheme.repRange[0];
    source = 'progression';
    rationale = `You hit ${lastTopReps} reps across the board — adding ${scheme.incrementKg}kg.`;
  } else if (lastTopReps >= scheme.repRange[1] && stalled) {
    topKg = lastTop;
    reps = scheme.repRange[1];
    source = 'repeat';
    rationale = `Top of the range, but your recent trend is flat — holding weight for one more session.`;
  } else {
    topKg = lastTop;
    reps = Math.min(lastTopReps + 1, scheme.repRange[1]);
    source = 'repeat';
    rationale = `${lastTopReps} reps last time — same weight, one more rep.`;
  }

  const decayed = topKg * decay;
  if (decay < 1) {
    const weeks = Math.round(daysBetween(state.lastSessionAt!, input.now) / 7);
    rationale = `${weeks} weeks off — starting back at about ${Math.round(decay * 100)}% of your last working weight.`;
    source = 'repeat';
    reps = scheme.repRange[0];
  }

  const topSnapped = snap(decayed);
  const sets = buildSets(topSnapped, shape, reps, snap);

  return {
    sets,
    confidence: confidenceFor(state, input.now, decay),
    source,
    rationale,
    impliedE1rm: epleyE1rm(topSnapped, reps),
    relativeIntensity: relativeIntensity(topSnapped, state.bestE1rm),
  };
}

function coldStart(
  input: PredictInput,
  scheme: ProgressionScheme,
  snap: (kg: number) => number,
): Prediction {
  const transfer = input.transfer;

  if (transfer && transfer.state.sessionCount > 0 && workingSets(transfer.state.lastSets).length) {
    const sourceTop = Math.max(...workingSets(transfer.state.lastSets).map((s) => s.weightKg!));
    // Deliberately conservative: a first attempt at an unfamiliar movement should
    // be too light rather than a failed set in front of the squad.
    const topKg = snap(sourceTop * transfer.ratio * 0.9);
    const label = transfer.label ?? 'a similar lift';
    return {
      sets: buildSets(topKg, flatShape(scheme.targetSets), scheme.repRange[0], snap),
      confidence: 'low',
      source: 'transfer',
      rationale: `First time on this one — scaled from ${label}. Shift starts light and corrects after a set.`,
      impliedE1rm: epleyE1rm(topKg, scheme.repRange[0]),
      relativeIntensity: null,
    };
  }

  const topKg = snap(input.fallbackKg ?? input.lattice?.minKg ?? 20);
  return {
    sets: buildSets(topKg, flatShape(scheme.targetSets), scheme.repRange[0], snap),
    confidence: 'none',
    source: 'default',
    rationale: `First time on this one — start light. Shift learns your working weight after a session or two.`,
    impliedE1rm: epleyE1rm(topKg, scheme.repRange[0]),
    relativeIntensity: null,
  };
}

/**
 * Learn the shape of the working sets rather than assuming straight sets.
 *
 * Someone running a heavy top set with back-offs should not be handed three
 * identical numbers to correct by hand — that is exactly the typing lazy logging
 * exists to remove. Ratios are taken against the heaviest set and reapplied to
 * the new top.
 */
export function inferSetShape(sets: readonly SetRecord[], targetSets: number): number[] {
  const weights = workingSets(sets)
    .map((s) => s.weightKg!)
    .filter((w) => w > 0);
  if (weights.length === 0) return flatShape(targetSets);

  const top = Math.max(...weights);
  const ratios = weights.map((w) => w / top);

  if (ratios.length >= targetSets) return ratios.slice(0, targetSets);
  const padded = [...ratios];
  while (padded.length < targetSets) padded.push(ratios[ratios.length - 1]!);
  return padded;
}

function flatShape(n: number): number[] {
  return Array<number>(n).fill(1);
}

function buildSets(
  topKg: number,
  shape: readonly number[],
  reps: number,
  snap: (kg: number) => number,
): PredictedSet[] {
  return shape.map((ratio, i) => ({
    setIndex: i,
    weightKg: ratio === 1 ? topKg : snap(topKg * ratio),
    reps,
    isTopSet: ratio >= Math.max(...shape),
  }));
}

/** Estimated strength retained after a layoff. 1 while training is current. */
export function detrainingFactor(
  lastSessionAt: string | null,
  now: string,
  model: DetrainingModel = DEFAULT_DETRAINING,
): number {
  if (lastSessionAt === null) return 1;
  const days = daysBetween(lastSessionAt, now);
  if (days <= model.graceDays) return 1;
  const weeksBeyond = (days - model.graceDays) / 7;
  return Math.max(model.floor, 1 - model.weeklyDecay * weeksBeyond);
}

function confidenceFor(state: ProgressionState, now: string, decay: number): Confidence {
  if (state.sessionCount === 0) return 'none';
  const days = state.lastSessionAt ? daysBetween(state.lastSessionAt, now) : Infinity;
  if (decay < 1 || days > 60 || state.sessionCount === 1) return 'low';
  if (state.sessionCount < 4 || days > 21) return 'medium';
  return 'high';
}

export function relativeIntensity(loadKg: number, bestE1rm: number | null): number | null {
  if (bestE1rm === null || bestE1rm <= 0) return null;
  return Math.round((loadKg / bestE1rm) * 1000) / 1000;
}

/** Top-set load for the rotation planner's `Member.plannedLoadKg` (§6.3). */
export function plannedLoadFrom(prediction: Prediction): number {
  return Math.max(...prediction.sets.map((s) => s.weightKg));
}

// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
