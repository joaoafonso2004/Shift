import { create } from 'zustand';

import { latticeFor } from '../domain/plates.ts';
import type { LoadLattice } from '../domain/plates.ts';
import {
  buildProgressionState,
  plannedLoadFrom,
  predictNextSession,
} from '../domain/progression.ts';
import type { Prediction } from '../domain/progression.ts';
import type { CatalogExercise } from '../domain/catalog.ts';
import type { SessionRecord } from '../domain/progression.ts';
import { getExercises } from '../data/catalog.ts';
import { openLocalDb } from '../data/localDb.ts';
import {
  addWorkoutExercise,
  finishWorkout,
  historyFor,
  logSet,
  removeSet as removeSetRow,
  startWorkout,
} from '../data/repository.ts';
import { STARTER_ROUTINE } from '../data/starterRoutine.ts';

/**
 * Workout session state — the JS-thread half of the runtime boundary.
 *
 * Everything here is a *fact*: what was logged, at what load, in what order.
 * Nothing that changes at frame rate lives in this store. A scrub gesture writes
 * to shared values and calls `updateSet` exactly once, when the finger lifts.
 */

export interface WorkoutSet {
  id: string;
  weightKg: number;
  reps: number;
  completed: boolean;
  /** False once the user has adjusted it — drives the "predicted" affordance. */
  fromPrediction: boolean;
}

export interface WorkoutExercise {
  /** Instance id. Distinct from the catalog id: the same exercise can appear twice. */
  id: string;
  exerciseId: string;
  catalog: CatalogExercise;
  sets: WorkoutSet[];
  prediction: Prediction | null;
  lattice: LoadLattice;
  /** What this replaced, for the swap analytics column and the "swapped from" hint. */
  swappedFrom?: CatalogExercise;
}

interface WorkoutState {
  status: 'idle' | 'active' | 'finished';
  startedAt: string | null;
  /** Local-database id for this session. Also the server idempotency key. */
  workoutId: string | null;
  exercises: WorkoutExercise[];
  activeIndex: number;

  /** `routineId` ties the session to a saved routine, which is how a shared
   *  routine gets credited for the workout it produced. */
  startRoutine: (ids?: readonly string[], routineId?: string | null) => void;
  finish: () => void;
  setActiveIndex: (index: number) => void;
  completeSet: (exerciseId: string, setId: string) => void;
  updateSet: (exerciseId: string, setId: string, patch: Partial<Pick<WorkoutSet, 'weightKg' | 'reps'>>) => void;
  addSet: (exerciseId: string) => void;
  removeSet: (exerciseId: string, setId: string) => void;
  reorderSets: (exerciseId: string, orderedIds: string[]) => void;
  replaceExercise: (instanceId: string, next: CatalogExercise) => void;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;

type History = Record<string, SessionRecord[]>;

/** Read every routine exercise's history from the local database in one pass. */
function loadHistory(ids: readonly string[]): History {
  const db = openLocalDb();
  const out: History = {};
  for (const id of ids) out[id] = historyFor(db, id);
  return out;
}

/**
 * Prediction transfer when swapping onto an unfamiliar exercise.
 *
 * Only offered between exercises using the **same equipment**, at a ratio of 1.0
 * — a barbell bench press variant genuinely carries your barbell bench weight.
 * Across equipment there is no honest ratio available yet (a dumbbell press is
 * quoted per hand, a machine's stack is arbitrary), and a wrong number in front
 * of a loaded bar is worse than admitting ignorance, so those cold-start instead.
 *
 * Populating cross-equipment ratios is the open catalog task noted in §7.6.
 */
function transferFor(
  target: CatalogExercise,
  source: CatalogExercise | undefined,
  history: History,
) {
  if (!source || source.loadType !== target.loadType) return undefined;
  const sourceState = buildProgressionState(source.id, history[source.id] ?? []);
  if (sourceState.sessionCount === 0) return undefined;
  return {
    fromExerciseId: source.id,
    state: sourceState,
    ratio: 1,
    label: source.name,
  };
}

function buildExercise(
  catalog: CatalogExercise,
  history: History,
  swappedFrom?: CatalogExercise,
): WorkoutExercise {
  const lattice = latticeFor(catalog.loadType);
  const state = buildProgressionState(catalog.id, history[catalog.id] ?? []);
  const transfer = transferFor(catalog, swappedFrom, history);
  const prediction = predictNextSession({
    state,
    now: new Date().toISOString(),
    lattice,
    ...(transfer ? { transfer } : {}),
  });

  return {
    id: nextId('wx'),
    exerciseId: catalog.id,
    catalog,
    lattice,
    prediction,
    sets: prediction.sets.map((s) => ({
      id: nextId('set'),
      weightKg: s.weightKg,
      reps: s.reps,
      completed: false,
      fromPrediction: true,
    })),
  };
}

function mapExercise(
  exercises: WorkoutExercise[],
  id: string,
  fn: (exercise: WorkoutExercise) => WorkoutExercise,
): WorkoutExercise[] {
  return exercises.map((exercise) => (exercise.id === id ? fn(exercise) : exercise));
}

export const useWorkout = create<WorkoutState>((set, get) => ({
  status: 'idle',
  startedAt: null,
  workoutId: null,
  exercises: [],
  activeIndex: 0,

  startRoutine: (ids = STARTER_ROUTINE, routineId = null) => {
    const db = openLocalDb();
    const history = loadHistory(ids);
    const catalog = getExercises(ids);
    const startedAt = new Date().toISOString();
    const workoutId = nextId('w');

    startWorkout(db, { id: workoutId, routineId, startedAt });

    const exercises = catalog.map((c, index) => {
      const built = buildExercise(c, history);
      addWorkoutExercise(db, {
        id: built.id,
        workoutId,
        exerciseId: c.id,
        swappedFromExerciseId: null,
        orderIndex: index,
        at: startedAt,
      });
      return built;
    });

    set({ status: 'active', startedAt, workoutId, activeIndex: 0, exercises });
  },

  finish: () => {
    const { workoutId } = get();
    if (workoutId) finishWorkout(openLocalDb(), workoutId, new Date().toISOString());
    set({ status: 'finished' });
  },

  setActiveIndex: (index) => {
    const max = get().exercises.length - 1;
    set({ activeIndex: Math.min(Math.max(index, 0), Math.max(max, 0)) });
  },

  // Writes through to the local database, which is what the predictor reads
  // next session. The network is never consulted: the tick appears because a
  // row was written locally, not because a server acknowledged anything.
  completeSet: (exerciseId, setId) => {
    // The database write happens *outside* the updater. A Zustand updater must
    // be pure: React StrictMode invokes it twice in development, which would
    // log every set twice and leave a duplicate in the outbox.
    const exercise = get().exercises.find((e) => e.id === exerciseId);
    const target = exercise?.sets.find((s) => s.id === setId);

    if (exercise && target) {
      const db = openLocalDb();
      const index = exercise.sets.indexOf(target);
      if (target.completed) {
        removeSetRow(db, target.id, new Date().toISOString());
      } else {
        logSet(db, {
          id: target.id,
          workoutExerciseId: exercise.id,
          exerciseId: exercise.exerciseId,
          setIndex: index,
          weightKg: target.weightKg,
          reps: target.reps,
          rpe: null,
          isWarmup: false,
          completedAt: new Date().toISOString(),
        });
      }
    }

    set((state) => ({
      exercises: mapExercise(state.exercises, exerciseId, (ex) => ({
        ...ex,
        sets: ex.sets.map((s) => (s.id === setId ? { ...s, completed: !s.completed } : s)),
      })),
    }));
  },

  updateSet: (exerciseId, setId, patch) =>
    set((state) => ({
      exercises: mapExercise(state.exercises, exerciseId, (exercise) => ({
        ...exercise,
        sets: exercise.sets.map((s) =>
          s.id === setId ? { ...s, ...patch, fromPrediction: false } : s,
        ),
      })),
    })),

  addSet: (exerciseId) =>
    set((state) => ({
      exercises: mapExercise(state.exercises, exerciseId, (exercise) => {
        const last = exercise.sets[exercise.sets.length - 1];
        return {
          ...exercise,
          sets: [
            ...exercise.sets,
            {
              id: nextId('set'),
              weightKg: last?.weightKg ?? exercise.lattice.minKg,
              reps: last?.reps ?? 8,
              completed: false,
              fromPrediction: true,
            },
          ],
        };
      }),
    })),

  removeSet: (exerciseId, setId) =>
    set((state) => ({
      exercises: mapExercise(state.exercises, exerciseId, (exercise) => ({
        ...exercise,
        sets: exercise.sets.filter((s) => s.id !== setId),
      })),
    })),

  reorderSets: (exerciseId, orderedIds) =>
    set((state) => ({
      exercises: mapExercise(state.exercises, exerciseId, (exercise) => {
        const byId = new Map(exercise.sets.map((s) => [s.id, s]));
        const reordered = orderedIds
          .map((id) => byId.get(id))
          .filter((s): s is WorkoutSet => s !== undefined);
        return { ...exercise, sets: reordered };
      }),
    })),

  replaceExercise: (instanceId, next) => {
    const state = get();
    const previous = state.exercises.find((e) => e.id === instanceId);
    if (!previous) return;

    const db = openLocalDb();
    const history = loadHistory([next.id, previous.exerciseId]);

    // Same reason as completeSet: the write is outside the updater so a
    // double-invoked reducer cannot duplicate it.
    addWorkoutExercise(db, {
      id: previous.id,
      workoutId: state.workoutId ?? '',
      exerciseId: next.id,
      swappedFromExerciseId: previous.exerciseId,
      orderIndex: state.exercises.indexOf(previous),
      at: new Date().toISOString(),
    });

    set((current) => ({
      exercises: mapExercise(current.exercises, instanceId, (prev) => {
        const rebuilt = buildExercise(next, history, prev.catalog);
        // The instance id is kept so the card ring and the sortable list are not
        // torn down and rebuilt by a key change mid-animation. It is also the
        // row id, so the swap updates the existing record rather than orphaning it.
        return { ...rebuilt, id: prev.id, swappedFrom: prev.catalog };
      }),
    }));
  },
}));

/** Top-set load the rotation planner would receive for this exercise (§6.3). */
export function plannedLoadOf(exercise: WorkoutExercise): number {
  return exercise.prediction ? plannedLoadFrom(exercise.prediction) : 0;
}
