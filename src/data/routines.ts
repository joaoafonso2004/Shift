import * as Crypto from 'expo-crypto';

import type { LoadType } from '../domain/catalog.ts';
import { EMPTY_RERANK_CONTEXT, rerankAlternatives } from '../domain/catalog.ts';
import {
  adaptRoutine,
  type AdaptContext,
  type AdaptedRoutine,
  type SharedRoutine,
} from '../domain/sharing.ts';
import { getAlternatives, getExercise } from './catalog.ts';
import { openLocalDb } from './localDb.ts';
import {
  exercisesWithHistory,
  getRoutine,
  markRoutineRun,
  saveRoutine,
  type RoutineSource,
} from './repository.ts';

/**
 * Everything `adaptRoutine` needs, wired to this device's catalog.
 *
 * Substitutes come from the same re-ranked list Swipe-to-Swap offers, so a
 * routine imported from a friend and a swap made mid-workout answer "what else
 * trains this" identically. Building a second ranking here would be two
 * definitions of the same judgement, drifting apart at the first fix to either.
 *
 * `hasHistory` is included for a reason worth stating: it biases substitutions
 * toward exercises Shift can already predict a weight for, which is what keeps
 * an imported routine from cold-starting half its lifts at the bare bar.
 */
export function adaptContextFor(availableEquipment: readonly LoadType[]): AdaptContext {
  const hasHistory = exercisesWithHistory(openLocalDb());

  return {
    lookup: (id) => getExercise(id),
    alternatives: (id) =>
      rerankAlternatives(getAlternatives(id), {
        ...EMPTY_RERANK_CONTEXT,
        availableLoadTypes: availableEquipment,
        hasHistory,
      }).map((ranked) => ranked.exercise),
    availableLoadTypes: availableEquipment,
  };
}

export interface ImportResult {
  routineId: string;
  adapted: AdaptedRoutine;
}

/**
 * Take a routine someone sent and make it this device's own.
 *
 * The adaptation happens once, at import, and the *result* is what gets stored.
 * Re-adapting on every open would mean a routine that silently changes when the
 * user edits their equipment list — and a plan that rewrites itself between two
 * sessions is not a plan.
 */
export function importSharedRoutine(
  shared: SharedRoutine,
  source: RoutineSource,
  availableEquipment: readonly LoadType[],
): ImportResult {
  const adapted = adaptRoutine(shared, adaptContextFor(availableEquipment));
  const routineId = Crypto.randomUUID();

  saveRoutine(openLocalDb(), {
    id: routineId,
    title: adapted.title,
    note: adapted.note,
    source,
    fromHandle: adapted.fromHandle,
    createdAt: new Date().toISOString(),
    exercises: adapted.items
      .filter((item) => item.exercise !== null)
      .map((item) => ({
        exerciseId: item.exercise!.id,
        sets: item.requested.sets,
        reps: item.requested.reps,
        restS: item.requested.restS ?? null,
      })),
  });

  return { routineId, adapted };
}

/**
 * Keep a session you just trained as a routine.
 *
 * No adaptation pass: these are already this device's own exercises, chosen and
 * possibly swapped by the person saving them. Running them through the
 * substitution logic could only make the routine *worse* than what they
 * actually did.
 */
export function saveSessionAsRoutine(shared: SharedRoutine): string {
  const routineId = Crypto.randomUUID();

  saveRoutine(openLocalDb(), {
    id: routineId,
    title: shared.title,
    note: shared.note,
    source: 'mine',
    fromHandle: null,
    createdAt: new Date().toISOString(),
    exercises: shared.exercises.map((exercise) => ({
      exerciseId: exercise.exerciseId,
      sets: exercise.sets,
      reps: exercise.reps,
      restS: exercise.restS ?? null,
    })),
  });

  return routineId;
}

/**
 * Catalog ids to hand to `startRoutine`, and a note that this routine was used.
 *
 * The timestamp is written here rather than when the workout finishes, because
 * the list is sorted by what someone reaches for — and a session abandoned after
 * two sets still says which routine they meant to train.
 */
export function startRoutineById(id: string): string[] {
  const db = openLocalDb();
  const routine = getRoutine(db, id);
  if (!routine) return [];

  markRoutineRun(db, id, new Date().toISOString());
  return routine.exercises.map((exercise) => exercise.exerciseId);
}
