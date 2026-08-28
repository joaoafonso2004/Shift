import type { CadenceReport, CadenceVerdict, Member, MemberCadence, TurnSlot } from './types.ts';

/** Rest exceeding this multiple of target means the rotation is stretching the session. */
export const BLOAT_THRESHOLD = 1.35;
/** Rest below this multiple of target, when the station refuses to wait, is starvation. */
export const STARVED_THRESHOLD = 0.75;
/** Spending more than this share of the session waiting means the rotation is too thin. */
export const IDLE_SHARE_THRESHOLD = 0.2;

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += x;
  return acc / xs.length;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Rotation-independent rest estimate: (N-1) x (work + transition).
 *
 * This is the §6.1 formula, and it is deliberately NOT how the report measures
 * actual rest. It exists to pick a pacing mode before a plan exists, breaking
 * the circular dependency (mode needs pressure, pressure needs a plan, a plan
 * needs a mode).
 */
export function baselineRestS(members: readonly Member[], avgTransitionS: number): number {
  const others = members.length - 1;
  if (others <= 0) return 0;
  return others * (mean(members.map((m) => m.avgWorkS)) + avgTransitionS);
}

/** Measure the rest each member actually received in a simulated plan. */
export function analyseCadence(
  slots: readonly TurnSlot[],
  members: readonly Member[],
): CadenceReport {
  const gaps = new Map<string, number[]>();
  for (const m of members) gaps.set(m.id, []);
  for (const s of slots) {
    if (s.restBeforeS === null) continue;
    gaps.get(s.memberId)?.push(s.restBeforeS);
  }

  const memberReports: MemberCadence[] = members.map((m) => {
    const g = gaps.get(m.id) ?? [];
    const violationS = g.reduce((acc, gap) => acc + Math.max(0, m.restTargetS - gap), 0);
    return {
      memberId: m.id,
      restTargetS: m.restTargetS,
      restGapsS: g.map(round1),
      minRestS: g.length > 0 ? round1(Math.min(...g)) : null,
      meanRestS: g.length > 0 ? round1(mean(g)) : null,
      violationS: round1(violationS),
    };
  });

  const observed = memberReports.filter((r) => r.meanRestS !== null).map((r) => r.meanRestS!);
  const targets = members.map((m) => m.restTargetS);
  const meanTarget = mean(targets);
  const restPressure = meanTarget > 0 && observed.length > 0 ? mean(observed) / meanTarget : 1;

  const totalIdleS = slots.reduce((acc, s) => acc + s.idleS, 0);
  const totalTimeS = slots.length > 0 ? slots[slots.length - 1]!.endsAtS : 0;
  const idleShare = totalTimeS > 0 ? totalIdleS / totalTimeS : 0;

  // A lone lifter idles between their own sets by definition — that is rest, not
  // a scheduling problem, so the idle test only applies to an actual rotation.
  const isSquad = members.length >= 2;

  let verdict: CadenceVerdict = 'ok';
  if (restPressure > BLOAT_THRESHOLD) verdict = 'rest-bloated';
  else if (isSquad && idleShare > IDLE_SHARE_THRESHOLD) verdict = 'rest-starved';
  else if (isSquad && restPressure < STARVED_THRESHOLD) verdict = 'rest-starved';

  return {
    members: memberReports,
    baselineRestS: 0, // filled in by the planner, which knows the transition model
    restPressure: Math.round(restPressure * 100) / 100,
    idleShare: Math.round(idleShare * 100) / 100,
    totalIdleS: round1(totalIdleS),
    verdict,
    recommendation: recommend(verdict, members.length, mean(observed), meanTarget, idleShare),
    totalViolationS: round1(memberReports.reduce((a, r) => a + r.violationS, 0)),
  };
}

function recommend(
  verdict: CadenceVerdict,
  memberCount: number,
  observedS: number,
  targetS: number,
  idleShare: number,
): string | null {
  const obs = Math.round(observedS);
  const tgt = Math.round(targetS);

  if (verdict === 'rest-bloated') {
    if (memberCount >= 3) {
      const a = Math.ceil(memberCount / 2);
      const b = memberCount - a;
      return `Rest is running ~${obs}s against a ${tgt}s target. Split into two stations (${a}+${b}) to roughly halve it.`;
    }
    return `Rest is running ~${obs}s against a ${tgt}s target. Shorten the rest target or add a filler exercise.`;
  }

  if (verdict === 'rest-starved') {
    const pct = Math.round(idleShare * 100);
    if (pct > 0) {
      return `You're waiting around ${pct}% of the session — ${memberCount} people can't fill a ${tgt}s rest. Merge with another station or add a filler set between turns.`;
    }
    return `Rest is only ~${obs}s against a ${tgt}s target. Raise the rest target or slow the rotation.`;
  }

  return null;
}
