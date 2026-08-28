import {
  DEFAULT_TRANSITION,
  plateDelta,
  plateMoveCount,
  transitionSeconds,
} from './plates.ts';
import type { LoadLattice, TransitionModel } from './plates.ts';
import { analyseCadence, baselineRestS } from './cadence.ts';
import { INACTIVE_STATES } from './types.ts';
import type {
  CadenceReport,
  Member,
  MemberId,
  PacingMode,
  StationPlan,
  StrategyName,
  TurnSlot,
} from './types.ts';

export interface StationPlanInput {
  members: readonly Member[];
  lattice: LoadLattice;
  /** Rounds to plan ahead. */
  rounds: number;
  pacingMode: PacingMode;
  transition?: TransitionModel;
  planVersion?: number;
}

type Ordering = 'fixed' | 'serpentine';

const ORDERING_OF: Record<StrategyName, Ordering> = {
  fixed: 'fixed',
  'fixed-idle': 'fixed',
  serpentine: 'serpentine',
  'serpentine-idle': 'serpentine',
};

const IDLES: Record<StrategyName, boolean> = {
  fixed: false,
  'fixed-idle': true,
  serpentine: false,
  'serpentine-idle': true,
};

const ALL_STRATEGIES: readonly StrategyName[] = [
  'fixed',
  'fixed-idle',
  'serpentine',
  'serpentine-idle',
];

const LABELS: Record<StrategyName, string> = {
  fixed: 'Even rotation',
  'fixed-idle': 'Even rotation, waiting for rest',
  serpentine: 'Flow (serpentine)',
  'serpentine-idle': 'Flow (serpentine), waiting for rest',
};

export function activeMembers(members: readonly Member[]): Member[] {
  return members.filter((m) => !INACTIVE_STATES.includes(m.state));
}

/**
 * Ascending by achievable load, ties broken by id.
 *
 * Ordering monotonically by load is optimal within a round regardless of
 * strategy: ascending means every changeover only adds plates, descending only
 * removes. Any other order forces both on the same transition.
 */
function baseOrder(members: readonly Member[], snapped: Map<MemberId, number>): MemberId[] {
  return [...members]
    .sort((a, b) => {
      const d = snapped.get(a.id)! - snapped.get(b.id)!;
      return d !== 0 ? d : a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

function orderingsFor(ordering: Ordering, base: readonly MemberId[], rounds: number): MemberId[][] {
  const out: MemberId[][] = [];
  for (let r = 0; r < rounds; r++) {
    if (ordering === 'fixed' || r % 2 === 0) out.push([...base]);
    else out.push([...base].reverse());
  }
  return out;
}

interface Simulation {
  slots: TurnSlot[];
  plateMoves: number;
  totalTimeS: number;
}

function simulate(
  orderings: readonly (readonly MemberId[])[],
  byId: Map<MemberId, Member>,
  snapped: Map<MemberId, number>,
  lattice: LoadLattice,
  transition: TransitionModel,
  allowIdle: boolean,
): Simulation {
  const slots: TurnSlot[] = [];
  const lastEnd = new Map<MemberId, number>();
  let t = 0;
  let plateMoves = 0;
  let ordinal = 0;
  let prevPlates: number[] = []; // the bar starts bare

  // Plate configurations are chosen across the whole sequence, not per turn:
  // what costs time is plates *moved* between turns, not plates used on one.
  const flat = orderings.flatMap((order) => [...order]);
  const configs = lattice.sequence(flat.map((id) => snapped.get(id)!));

  for (let roundIndex = 0; roundIndex < orderings.length; roundIndex++) {
    const order = orderings[roundIndex]!;
    for (let slot = 0; slot < order.length; slot++) {
      const memberId = order[slot]!;
      const m = byId.get(memberId)!;
      const loadKg = snapped.get(memberId)!;
      const perSide = configs[ordinal]!;
      const delta = plateDelta(prevPlates, perSide);
      const transitionS = transitionSeconds(delta, transition);

      let startsAtS = t + transitionS;
      let idleS = 0;
      const prevEnd = lastEnd.get(memberId);
      if (prevEnd !== undefined && allowIdle) {
        const readyAt = prevEnd + m.restTargetS;
        if (readyAt > startsAtS) {
          idleS = readyAt - startsAtS;
          startsAtS = readyAt;
        }
      }
      const endsAtS = startsAtS + m.avgWorkS;

      slots.push({
        roundIndex,
        slot,
        ordinal: ordinal++,
        memberId,
        loadKg,
        requestedKg: m.plannedLoadKg,
        perSide,
        plateDelta: delta,
        transitionS,
        idleS,
        startsAtS,
        endsAtS,
        restBeforeS: prevEnd === undefined ? null : startsAtS - prevEnd,
      });

      plateMoves += plateMoveCount(delta);
      lastEnd.set(memberId, endsAtS);
      t = endsAtS;
      prevPlates = perSide;
    }
  }

  return { slots, plateMoves, totalTimeS: t };
}

interface Candidate extends Simulation {
  strategy: StrategyName;
  cadence: CadenceReport;
}

/**
 * Lexicographic: rest debt, then wall-clock time, then plate handling.
 *
 * Rest debt ranks first because it is a training-quality failure rather than an
 * inconvenience — no amount of saved time compensates for sets taken too soon.
 *
 * Time ranks above plate moves deliberately. Plate moves are *already counted*
 * inside total time via the transition model, so ranking them higher
 * double-counts a proxy against the quantity it approximates. Scored the other
 * way round, a four-person squad picks serpentine-idle — saving six plate moves
 * (~24s of handling) at the cost of ~144s of everyone standing around, because
 * the boundary lifter's forced idle never appears in the plate count. Moves
 * survive only as a tie-break: at equal time, less faff is better.
 */
function isBetter(a: Candidate, b: Candidate): boolean {
  if (a.cadence.totalViolationS !== b.cadence.totalViolationS) {
    return a.cadence.totalViolationS < b.cadence.totalViolationS;
  }
  if (a.totalTimeS !== b.totalTimeS) return a.totalTimeS < b.totalTimeS;
  if (a.plateMoves !== b.plateMoves) return a.plateMoves < b.plateMoves;
  return ALL_STRATEGIES.indexOf(a.strategy) < ALL_STRATEGIES.indexOf(b.strategy);
}

function candidatesFor(mode: PacingMode): readonly StrategyName[] {
  if (mode === 'even') return ['fixed', 'fixed-idle'];
  if (mode === 'flow') return ['serpentine', 'serpentine-idle'];
  return ALL_STRATEGIES;
}

function emptyCadence(): CadenceReport {
  return {
    members: [],
    baselineRestS: 0,
    restPressure: 1,
    idleShare: 0,
    totalIdleS: 0,
    verdict: 'ok',
    recommendation: null,
    totalViolationS: 0,
  };
}

function describe(chosen: Candidate, runnerUp: Candidate | null): string {
  const mins = (s: number) => `${Math.round(s / 6) / 10}min`;
  const rest =
    chosen.cadence.totalViolationS === 0
      ? 'rest targets met'
      : `${Math.round(chosen.cadence.totalViolationS)}s rest debt`;
  const head = `${LABELS[chosen.strategy]}: ${chosen.plateMoves} plate moves, ${mins(
    chosen.totalTimeS,
  )}, ${rest}.`;

  if (!runnerUp) return head;
  const rRest =
    runnerUp.cadence.totalViolationS === 0
      ? 'rest met'
      : `${Math.round(runnerUp.cadence.totalViolationS)}s debt`;
  return `${head} Beat ${LABELS[runnerUp.strategy]} (${runnerUp.plateMoves} moves, ${mins(
    runnerUp.totalTimeS,
  )}, ${rRest}).`;
}

/**
 * Build a station rotation: who lifts when, at what achievable load, and which
 * plates move between turns.
 *
 * Deterministic — same inputs produce the same plan on every client, which is
 * what lets the server compute it once and broadcast a `plan_version` instead of
 * shipping the whole plan on every change.
 */
export function planStation(input: StationPlanInput): StationPlan {
  const transition = input.transition ?? DEFAULT_TRANSITION;
  const planVersion = input.planVersion ?? 0;
  const members = activeMembers(input.members);

  if (members.length === 0 || input.rounds <= 0) {
    return {
      planVersion,
      strategy: 'fixed',
      slots: [],
      cadence: emptyCadence(),
      plateMoves: 0,
      totalTimeS: 0,
      rationale: 'No active members at this station.',
    };
  }

  const byId = new Map(members.map((m) => [m.id, m]));
  const snapped = new Map(members.map((m) => [m.id, input.lattice.snap(m.plannedLoadKg)]));
  const base = baseOrder(members, snapped);

  let chosen: Candidate | null = null;
  let runnerUp: Candidate | null = null;

  for (const strategy of candidatesFor(input.pacingMode)) {
    const sim = simulate(
      orderingsFor(ORDERING_OF[strategy], base, input.rounds),
      byId,
      snapped,
      input.lattice,
      transition,
      IDLES[strategy],
    );
    const candidate: Candidate = {
      ...sim,
      strategy,
      cadence: analyseCadence(sim.slots, members),
    };
    if (chosen === null || isBetter(candidate, chosen)) {
      runnerUp = chosen;
      chosen = candidate;
    } else if (runnerUp === null || isBetter(candidate, runnerUp)) {
      runnerUp = candidate;
    }
  }

  const winner = chosen!;
  return {
    planVersion,
    strategy: winner.strategy,
    slots: winner.slots,
    cadence: {
      ...winner.cadence,
      baselineRestS: Math.round(baselineRestS(members, transition.setupS)),
    },
    plateMoves: winner.plateMoves,
    totalTimeS: Math.round(winner.totalTimeS),
    rationale: describe(winner, runnerUp),
  };
}

/**
 * The next turn that should actually happen, skipping members who have gone
 * `away` or `stalled`. Mirrors the SQL `next_in_rotation()` so client prediction
 * and server truth agree; the server remains authoritative via `advance_turn()`.
 */
export function nextInRotation(
  plan: StationPlan,
  fromOrdinal: number,
  states: ReadonlyMap<MemberId, Member['state']>,
): TurnSlot | null {
  for (const slot of plan.slots) {
    if (slot.ordinal <= fromOrdinal) continue;
    const state = states.get(slot.memberId);
    if (state !== undefined && INACTIVE_STATES.includes(state)) continue;
    return slot;
  }
  return null;
}
