/** Core domain types for squad rotation and load planning. Pure data, no React. */

export type MemberId = string;

export type MemberState =
  | 'idle'
  | 'working'
  | 'resting'
  | 'ready'
  | 'stalled'
  | 'away';

/** Members in these states are skipped by the rotation (see §2.5 liveness). */
export const INACTIVE_STATES: readonly MemberState[] = ['stalled', 'away'];

export type PacingMode = 'auto' | 'flow' | 'even';

/**
 * A strategy is an ordering crossed with an idle policy.
 *
 * Ordering decides plate cost; the idle policy decides whether the station waits
 * for a member who has not finished resting, or whether the squad powers through
 * and accepts the rest debt. Both axes matter and neither dominates, so all four
 * combinations are scored (§6.2) rather than picked by a hardcoded heuristic.
 *
 * `serpentine-guarded` (reverse the round, then rotate left by one so the
 * boundary member does not lift twice in a row) was evaluated and dropped:
 * rotating left destroys the monotonic load ordering, so its plate cost
 * collapses to exactly `fixed`'s while being harder to explain. If it reappears
 * in a diff, this is why it should not.
 */
export type StrategyName = 'fixed' | 'fixed-idle' | 'serpentine' | 'serpentine-idle';

export interface Member {
  id: MemberId;
  colorSlot: 0 | 1 | 2 | 3;
  /** What the progression predictor asked for. Snapped to the lattice by the planner. */
  plannedLoadKg: number;
  plannedReps: number;
  targetSets: number;
  /** Rolling measured average of time under the bar. Not a guess (§6.1). */
  avgWorkS: number;
  restTargetS: number;
  state: MemberState;
}

/** Plates to move, per side, between two consecutive turns. */
export interface PlateDelta {
  add: number[];
  remove: number[];
}

export interface TurnSlot {
  roundIndex: number;
  /** Index within the round. */
  slot: number;
  /** Absolute index across the whole plan. */
  ordinal: number;
  memberId: MemberId;
  /** Achievable load actually used. */
  loadKg: number;
  /** What the predictor wanted, before snapping. */
  requestedKg: number;
  /** Plates per side, descending. Empty for non-plate-loaded equipment. */
  perSide: number[];
  plateDelta: PlateDelta;
  /** Changeover cost into this turn: setup + plate handling + any forced idle. */
  transitionS: number;
  /** Idle deliberately inserted to satisfy this member's rest target. */
  idleS: number;
  startsAtS: number;
  endsAtS: number;
  /** Actual rest this member received before this turn. Null on their first turn. */
  restBeforeS: number | null;
}

export interface MemberCadence {
  memberId: MemberId;
  restTargetS: number;
  restGapsS: number[];
  minRestS: number | null;
  meanRestS: number | null;
  /** Total seconds of rest owed but not received, across the plan. */
  violationS: number;
}

export type CadenceVerdict = 'ok' | 'rest-bloated' | 'rest-starved';

export interface CadenceReport {
  members: MemberCadence[];
  /** Rotation-independent baseline: (N-1) x (work + transition). Used to pick pacing mode. */
  baselineRestS: number;
  /** Mean observed rest / mean rest target across the squad. */
  restPressure: number;
  /**
   * Share of the session spent with nobody lifting.
   *
   * Bloat and starvation surface differently: a rotation that gives too much
   * rest shows up in `restPressure`, but a rotation that gives too little shows
   * up here — because the station waits rather than letting someone lift early.
   */
  idleShare: number;
  totalIdleS: number;
  verdict: CadenceVerdict;
  recommendation: string | null;
  totalViolationS: number;
}

export interface StationPlan {
  planVersion: number;
  strategy: StrategyName;
  slots: TurnSlot[];
  cadence: CadenceReport;
  /** Total individual plates handled across the plan (per side). */
  plateMoves: number;
  totalTimeS: number;
  /** Human-readable justification for the chosen strategy. Surfaced in the UI. */
  rationale: string;
}
