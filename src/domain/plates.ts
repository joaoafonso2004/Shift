import { toCKg, toKg } from './units.ts';
import type { PlateDelta } from './types.ts';

/** Plate counts are always PER SIDE, matching `sync_sessions.plate_inventory`. */
export type PlateInventory = Record<string, number>;

export interface BarConfig {
  barWeightKg: number;
  /** Smallest progression step the gym can express. Informational for the predictor. */
  minIncrementKg: number;
}

export interface LoadLattice {
  /** Every achievable total load, ascending. */
  readonly totals: readonly number[];
  readonly minKg: number;
  readonly maxKg: number;
  readonly isPlateLoaded: boolean;
  /** Nearest achievable load. Ties resolve downward — never silently overshoot a prediction. */
  snap(targetKg: number): number;
  /** Plates per side for one load in isolation, descending. Empty for fixed-increment kit. */
  platesFor(totalKg: number): number[];
  /**
   * Plate configurations for a whole ordered sequence of loads, chosen to
   * minimise plates moved between consecutive turns rather than plates used on
   * any single turn. See `solveSequence`.
   */
  sequence(loadsKg: readonly number[]): number[][];
}

interface Denomination {
  cKg: number;
  count: number;
}

function parseInventory(inv: PlateInventory): Denomination[] {
  return Object.entries(inv)
    .map(([kg, count]) => ({ cKg: toCKg(Number(kg)), count: Math.floor(count) }))
    .filter((d) => d.cKg > 0 && d.count > 0)
    .sort((a, b) => b.cKg - a.cKg);
}

function tallyToDenoms(plates: readonly number[]): Denomination[] {
  const m = new Map<number, number>();
  for (const p of plates) {
    const k = toCKg(p);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([cKg, count]) => ({ cKg, count }))
    .sort((a, b) => b.cKg - a.cKg);
}

function subtractDenoms(from: readonly Denomination[], used: readonly number[]): Denomination[] {
  const m = new Map(from.map((d) => [d.cKg, d.count]));
  for (const p of used) {
    const k = toCKg(p);
    const n = m.get(k);
    if (n !== undefined) m.set(k, n - 1);
  }
  return [...m.entries()]
    .filter(([, count]) => count > 0)
    .map(([cKg, count]) => ({ cKg, count }))
    .sort((a, b) => b.cKg - a.cKg);
}

/**
 * Bounded knapsack: fewest plates from `denoms` summing to exactly `targetCKg`.
 * Solved one layer per denomination so the chosen counts reconstruct exactly.
 *
 * A greedy largest-first solver is the obvious implementation and it is wrong:
 * with plates {25x1, 20x1, 15x1} a 35 kg side is reachable as 20+15, but greedy
 * takes 25 first and cannot finish. Greedy reports "unachievable" for loads the
 * gym can actually make.
 */
function solveSubset(denoms: readonly Denomination[], targetCKg: number): number[] | null {
  if (targetCKg === 0) return [];
  if (targetCKg < 0) return null;

  let dpPrev = new Int32Array(targetCKg + 1).fill(-1);
  dpPrev[0] = 0;
  const layers: Uint8Array[] = [];

  for (const d of denoms) {
    const dpCur = new Int32Array(targetCKg + 1).fill(-1);
    const usedK = new Uint8Array(targetCKg + 1);
    for (let sum = 0; sum <= targetCKg; sum++) {
      let best = -1;
      let bestK = 0;
      for (let k = 0; k <= d.count; k++) {
        const prev = sum - k * d.cKg;
        if (prev < 0) break;
        const prevCost = dpPrev[prev]!;
        if (prevCost < 0) continue;
        const cand = prevCost + k;
        if (best < 0 || cand < best) {
          best = cand;
          bestK = k;
        }
      }
      dpCur[sum] = best;
      usedK[sum] = bestK;
    }
    dpPrev = dpCur;
    layers.push(usedK);
  }

  if (dpPrev[targetCKg]! < 0) return null;

  const out: number[] = [];
  let sum = targetCKg;
  for (let i = layers.length - 1; i >= 0; i--) {
    const k = layers[i]![sum]!;
    const d = denoms[i]!;
    for (let j = 0; j < k; j++) out.push(toKg(d.cKg));
    sum -= k * d.cKg;
  }
  return out.sort((a, b) => b - a);
}

/** Removing more plates per side than this is a full re-rack; stop searching. */
const MAX_REMOVALS_CONSIDERED = 4;

/** Every distinct sub-multiset of `items` up to `maxSize`, as flat kg arrays. */
function subMultisets(items: readonly Denomination[], maxSize: number): number[][] {
  let acc: number[][] = [[]];
  for (const d of items) {
    const next: number[][] = [];
    for (const base of acc) {
      for (let k = 0; k <= d.count; k++) {
        if (base.length + k > maxSize) break;
        next.push(k === 0 ? base : [...base, ...Array<number>(k).fill(toKg(d.cKg))]);
      }
    }
    acc = next;
  }
  return acc.sort((a, b) => a.length - b.length);
}

function removeFrom(current: readonly number[], removed: readonly number[]): number[] {
  const out = [...current];
  for (const p of removed) {
    const i = out.indexOf(p);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/**
 * The cheapest configuration summing to `targetCKg`, measured in plates moved
 * from `current` rather than plates used.
 *
 * Search order is by removal count, bounded by the best total found so far:
 * keeping everything (a pure add) is tried first, then one removal, and so on.
 * With plate counts this small the search is a few dozen candidates.
 */
function bestStep(
  denoms: readonly Denomination[],
  current: readonly number[],
  targetCKg: number,
): number[] {
  let best: number[] | null = null;
  let bestMoves = Infinity;

  for (const removed of subMultisets(tallyToDenoms(current), MAX_REMOVALS_CONSIDERED)) {
    if (removed.length >= bestMoves) break; // sorted by size: nothing later can win
    const kept = removeFrom(current, removed);
    const keptSum = kept.reduce((acc, p) => acc + toCKg(p), 0);
    if (keptSum > targetCKg) continue;

    const added = solveSubset(subtractDenoms(denoms, kept), targetCKg - keptSum);
    if (!added) continue;

    const moves = removed.length + added.length;
    if (moves < bestMoves) {
      bestMoves = moves;
      best = [...kept, ...added].sort((a, b) => b - a);
    }
  }

  // Nothing expressible from the current state: strip the bar and start over.
  return best ?? solveSubset(denoms, targetCKg) ?? [];
}

/**
 * Choose plate configurations across an ordered sequence of loads.
 *
 * Solving each load independently minimises plates *used* but not plates
 * *moved*, and moved is what costs the squad time. With a 20 kg bar going
 * 60 -> 80 kg, an isolated solver may pick [25,5] then [20,10,10] — five plates
 * handled — where [20] then [20,10] is one. Over a four-person round that is the
 * difference between a brisk rotation and a plate-shuffling session.
 *
 * Each step is therefore solved as a minimal delta from the bar's current state.
 *
 * Known limitation: this is greedy across the sequence — each step is optimal
 * given the previous configuration, but the *first* configuration is chosen
 * without lookahead. For a descending sequence 50/40/30/20 per side, opening
 * with [25,25] is the fewest plates but decomposes badly, where [20,10,10,10]
 * costs more up front and then strips one plate per turn. Making this optimal is
 * a shortest path over configurations; it is worth doing only if measured
 * transition times justify it.
 */
export function solveSequence(
  bar: BarConfig,
  inv: PlateInventory,
  loadsKg: readonly number[],
): number[][] {
  const denoms = parseInventory(inv);
  const barCKg = toCKg(bar.barWeightKg);
  const out: number[][] = [];
  let current: number[] = [];
  let currentSum = 0;

  for (const load of loadsKg) {
    const delta = toCKg(load) - barCKg;
    const target = delta >= 0 && delta % 2 === 0 ? delta / 2 : -1;

    if (target < 0) {
      out.push([]);
      current = [];
      currentSum = 0;
      continue;
    }

    if (target === currentSum) {
      out.push([...current]);
      continue;
    }

    const next = bestStep(denoms, current, target);
    out.push(next);
    current = next;
    currentSum = target;
  }

  return out;
}

/** Enumerate every load a barbell can express, given a bar and a finite plate inventory. */
export function buildBarbellLattice(bar: BarConfig, inv: PlateInventory): LoadLattice {
  const denoms = parseInventory(inv);
  const barCKg = toCKg(bar.barWeightKg);
  const maxPerSide = denoms.reduce((acc, d) => acc + d.cKg * d.count, 0);

  const reachable = new Set<number>([0]);
  for (const d of denoms) {
    for (const s of [...reachable]) {
      for (let k = 1; k <= d.count; k++) {
        const next = s + k * d.cKg;
        if (next <= maxPerSide) reachable.add(next);
      }
    }
  }

  const totals = [...reachable].sort((a, b) => a - b).map((s) => toKg(barCKg + 2 * s));

  return {
    totals,
    minKg: totals[0]!,
    maxKg: totals[totals.length - 1]!,
    isPlateLoaded: true,
    snap: (target) => snapTo(totals, target),
    platesFor(totalKg) {
      const delta = toCKg(totalKg) - barCKg;
      if (delta < 0 || delta % 2 !== 0) return [];
      return solveSubset(denoms, delta / 2) ?? [];
    },
    sequence: (loadsKg) => solveSequence(bar, inv, loadsKg),
  };
}

/** A typical commercial-gym barbell setup. Overridden per session once gyms are modelled. */
export const DEFAULT_BAR: BarConfig = { barWeightKg: 20, minIncrementKg: 1.25 };
export const DEFAULT_PLATES: PlateInventory = {
  '25': 4, '20': 4, '15': 2, '10': 4, '5': 4, '2.5': 4, '1.25': 2,
};

/**
 * The set of loads a given kind of equipment can express.
 *
 * This is what a scrub gesture steps through, so an unachievable weight becomes
 * unreachable by construction rather than something corrected afterwards.
 */
export function latticeFor(
  loadType: string,
  bar: BarConfig = DEFAULT_BAR,
  plates: PlateInventory = DEFAULT_PLATES,
): LoadLattice {
  switch (loadType) {
    case 'barbell':
    case 'smith':
      return buildBarbellLattice(bar, plates);
    case 'dumbbell':
    case 'kettlebell':
      return buildFixedIncrementLattice({ minKg: 2, maxKg: 60, stepKg: 2 });
    case 'cable':
    case 'machine':
    case 'assisted':
      return buildFixedIncrementLattice({ minKg: 5, maxKg: 150, stepKg: 5 });
    default:
      // Bodyweight, bands and oddities: added load only, in small steps.
      return buildFixedIncrementLattice({ minKg: 0, maxKg: 60, stepKg: 1.25 });
  }
}

/** Dumbbells, machines, plate stacks — loads exist on a grid and never require plate handling. */
export function buildFixedIncrementLattice(opts: {
  minKg: number;
  maxKg: number;
  stepKg: number;
}): LoadLattice {
  const totals: number[] = [];
  const step = toCKg(opts.stepKg);
  const max = toCKg(opts.maxKg);
  for (let c = toCKg(opts.minKg); c <= max; c += step) totals.push(toKg(c));

  return {
    totals,
    minKg: totals[0]!,
    maxKg: totals[totals.length - 1]!,
    isPlateLoaded: false,
    snap: (target) => snapTo(totals, target),
    platesFor: () => [],
    sequence: (loadsKg) => loadsKg.map(() => []),
  };
}

/**
 * Nearest achievable value by binary search. O(log n), allocation-free — cheap
 * enough to run inside a worklet if a scrub gesture ever needs live snapping.
 */
export function snapTo(totals: readonly number[], targetKg: number): number {
  if (totals.length === 0) return targetKg;
  const target = toCKg(targetKg);
  let lo = 0;
  let hi = totals.length - 1;
  if (target <= toCKg(totals[lo]!)) return totals[lo]!;
  if (target >= toCKg(totals[hi]!)) return totals[hi]!;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (toCKg(totals[mid]!) <= target) lo = mid;
    else hi = mid;
  }
  const low = totals[lo]!;
  const high = totals[hi]!;
  // Ties resolve downward: overshooting a predicted load is the worse failure.
  return target - toCKg(low) <= toCKg(high) - target ? low : high;
}

/** Multiset difference between two per-side plate configurations. */
export function plateDelta(from: readonly number[], to: readonly number[]): PlateDelta {
  const a = new Map<number, number>();
  const b = new Map<number, number>();
  for (const p of from) a.set(toCKg(p), (a.get(toCKg(p)) ?? 0) + 1);
  for (const p of to) b.set(toCKg(p), (b.get(toCKg(p)) ?? 0) + 1);

  const add: number[] = [];
  const remove: number[] = [];
  for (const [cKg, n] of b) {
    for (let i = 0; i < n - (a.get(cKg) ?? 0); i++) add.push(toKg(cKg));
  }
  for (const [cKg, n] of a) {
    for (let i = 0; i < n - (b.get(cKg) ?? 0); i++) remove.push(toKg(cKg));
  }

  add.sort((x, y) => y - x);
  remove.sort((x, y) => y - x);
  return { add, remove };
}

export interface TransitionModel {
  /** Changeover cost paid on every turn: one lifter out, the next set up. */
  setupS: number;
  /** Cost of relocating one plate on BOTH sides — you walk around the bar. */
  perPlateS: number;
}

/** Calibrate against measured `turn_started_at` deltas once real sessions exist (§6.3). */
export const DEFAULT_TRANSITION: TransitionModel = { setupS: 8, perPlateS: 4 };

export function plateMoveCount(delta: PlateDelta): number {
  return delta.add.length + delta.remove.length;
}

export function transitionSeconds(
  delta: PlateDelta,
  model: TransitionModel = DEFAULT_TRANSITION,
): number {
  return model.setupS + model.perPlateS * plateMoveCount(delta);
}
