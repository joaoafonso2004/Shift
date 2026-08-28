/**
 * Sharing a workout with someone.
 *
 * What travels is the *shape* of a session — which exercises, in what order,
 * how many sets, how many reps — and never the load. That is not a filter
 * applied on the way out; `SharedExercise` has no field for a weight, so there
 * is nowhere for one to be. A rule enforced by a type cannot be forgotten by
 * the next person to add a field to the payload.
 *
 * This is also the honest version of the feature. A weight is meaningless
 * outside the body that lifted it: 80 kg is a warm-up for one friend and a
 * one-rep max for another, and an app that copies the number across is either
 * asking someone to fail or handing them something trivial. Shift already knows
 * what *you* can lift — the receiver's own predictor fills in every load from
 * their own history, so what arrives is a plan they can actually run. It also
 * keeps invariant 13 intact: absolute weights never appear in anything social.
 *
 * Pure TypeScript, zero dependencies, no React and no expo — the whole module is
 * reachable from the Node test suite.
 */

import type { CatalogExercise, LoadType } from './catalog.ts';

export const SHARE_VERSION = 1;

/** Enough for the longest real programme; small enough to bound a hostile payload. */
export const MAX_SHARED_EXERCISES = 24;
export const MAX_TITLE_LENGTH = 60;
export const MAX_NOTE_LENGTH = 280;

export const MAX_SETS = 20;
export const MAX_REPS = 100;
export const MAX_REST_S = 900;

/**
 * One exercise as it crosses between two people.
 *
 * `name` is carried even though the id resolves against a local catalog, so a
 * receiver running an older catalog build still sees what they were sent rather
 * than a blank row. It is a label, never an identity — everything the app does
 * with this exercise goes through `exerciseId`.
 *
 * `restS` is optional on purpose. Rest in Shift comes from the receiver's own
 * settings (compound vs isolation), and that default is usually right. An
 * explicit value means the sender deliberately prescribed one, and only then
 * does it override.
 */
export interface SharedExercise {
  exerciseId: string;
  name: string;
  sets: number;
  reps: number;
  restS?: number;
}

export interface SharedRoutine {
  version: typeof SHARE_VERSION;
  title: string;
  note: string | null;
  exercises: SharedExercise[];
  /** Sender's handle, for attribution in the receiver's list. Null over a link. */
  fromHandle: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Building one from a session
// ---------------------------------------------------------------------------

/**
 * The slice of a live workout this module needs.
 *
 * Declared structurally rather than importing the store's `WorkoutExercise`,
 * which drags in the catalog record, the lattice and the prediction — none of
 * which can travel. Anything the caller passes that carries a weight is simply
 * not read.
 */
export interface SessionShapeExercise {
  exerciseId: string;
  name: string;
  sets: readonly { reps: number; completed?: boolean }[];
  restS?: number;
}

/**
 * Most common rep count, ties resolved toward the first set.
 *
 * A mean would report 8.67 for a 10/8/8, and nobody writes a programme that
 * way. The mode is the number a human would have written down, and biasing ties
 * toward the opening set matches how people describe a session they just did —
 * "threes today", named after where it started.
 */
function modalReps(sets: readonly { reps: number }[]): number {
  const counts = new Map<number, number>();
  for (const set of sets) counts.set(set.reps, (counts.get(set.reps) ?? 0) + 1);

  let best = sets[0]?.reps ?? 0;
  let bestCount = 0;
  for (const set of sets) {
    const count = counts.get(set.reps) ?? 0;
    if (count > bestCount) {
      best = set.reps;
      bestCount = count;
    }
  }
  return best;
}

export interface BuildRoutineInput {
  title: string;
  exercises: readonly SessionShapeExercise[];
  note?: string | null;
  fromHandle?: string | null;
  now?: string;
  /**
   * Share what was actually done rather than what was planned.
   *
   * Sending a session you abandoned halfway as though you finished it is the
   * quiet lie this flag exists to avoid. Off, the whole plan travels — which is
   * what you want when sharing a routine you have written but not yet run.
   */
  completedOnly?: boolean;
}

export function routineFromSession(input: BuildRoutineInput): SharedRoutine {
  const exercises: SharedExercise[] = [];

  for (const exercise of input.exercises) {
    const sets = input.completedOnly
      ? exercise.sets.filter((s) => s.completed)
      : exercise.sets;
    if (sets.length === 0) continue;

    const shared: SharedExercise = {
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      sets: Math.min(sets.length, MAX_SETS),
      reps: clampInt(modalReps(sets), 1, MAX_REPS),
    };
    if (exercise.restS !== undefined) {
      shared.restS = clampInt(exercise.restS, 0, MAX_REST_S);
    }
    exercises.push(shared);

    if (exercises.length >= MAX_SHARED_EXERCISES) break;
  }

  return {
    version: SHARE_VERSION,
    title: trimTo(input.title, MAX_TITLE_LENGTH) || 'Workout',
    note: input.note ? trimTo(input.note, MAX_NOTE_LENGTH) : null,
    exercises,
    fromHandle: input.fromHandle ?? null,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

/** A single exercise is just a one-item routine. Same payload, same parser, same limits. */
export function shareOneExercise(
  exercise: { id: string; name: string },
  options: {
    sets?: number;
    reps?: number;
    note?: string | null;
    fromHandle?: string | null;
    now?: string;
  } = {},
): SharedRoutine {
  return routineFromSession({
    title: exercise.name,
    exercises: [
      {
        exerciseId: exercise.id,
        name: exercise.name,
        sets: Array.from({ length: options.sets ?? 3 }, () => ({ reps: options.reps ?? 8 })),
      },
    ],
    note: options.note ?? null,
    fromHandle: options.fromHandle ?? null,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

export type ShareProblem =
  | 'not-an-object'
  | 'bad-version'
  | 'no-exercises'
  | 'too-many-exercises'
  | 'bad-exercise';

export type ParseResult =
  | { ok: true; routine: SharedRoutine }
  | { ok: false; reason: ShareProblem };

/**
 * Parse an incoming payload.
 *
 * This is the one place in the app where the input was written by *another
 * user*, so nothing is trusted: every field is checked for type and range, and
 * strings are truncated rather than rejected so a slightly-too-long title does
 * not throw away a whole routine. Unknown keys are dropped by construction,
 * because the result is built field by field rather than spread from the input.
 */
export function parseSharedRoutine(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'not-an-object' };
  }

  const raw = input as Record<string, unknown>;
  if (raw.version !== SHARE_VERSION) return { ok: false, reason: 'bad-version' };
  if (!Array.isArray(raw.exercises) || raw.exercises.length === 0) {
    return { ok: false, reason: 'no-exercises' };
  }
  if (raw.exercises.length > MAX_SHARED_EXERCISES) {
    return { ok: false, reason: 'too-many-exercises' };
  }

  const exercises: SharedExercise[] = [];
  for (const entry of raw.exercises) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: 'bad-exercise' };
    const item = entry as Record<string, unknown>;

    const id = typeof item.exerciseId === 'string' ? item.exerciseId.trim() : '';
    if (!isPlausibleExerciseId(id)) return { ok: false, reason: 'bad-exercise' };

    const shared: SharedExercise = {
      exerciseId: id,
      name: typeof item.name === 'string' ? trimTo(item.name, MAX_TITLE_LENGTH) : '',
      sets: clampInt(item.sets, 1, MAX_SETS, 3),
      reps: clampInt(item.reps, 1, MAX_REPS, 8),
    };
    if (typeof item.restS === 'number' && Number.isFinite(item.restS)) {
      shared.restS = clampInt(item.restS, 0, MAX_REST_S, 0);
    }
    exercises.push(shared);
  }

  return {
    ok: true,
    routine: {
      version: SHARE_VERSION,
      title:
        typeof raw.title === 'string' ? trimTo(raw.title, MAX_TITLE_LENGTH) || 'Workout' : 'Workout',
      note: typeof raw.note === 'string' && raw.note.trim() ? trimTo(raw.note, MAX_NOTE_LENGTH) : null,
      exercises,
      fromHandle: typeof raw.fromHandle === 'string' && raw.fromHandle ? trimTo(raw.fromHandle, 20) : null,
      createdAt:
        typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
          ? raw.createdAt
          : new Date(0).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Adapting it to the person who received it
// ---------------------------------------------------------------------------

export type AdaptStatus = 'kept' | 'substituted' | 'unavailable';

export interface AdaptedExercise {
  status: AdaptStatus;
  /** What the sender asked for, resolved against the local catalog where possible. */
  requested: SharedExercise;
  /** What this device will actually run. Null when nothing suitable exists. */
  exercise: CatalogExercise | null;
  /** Set when a substitution happened, for the "swapped because" line in the UI. */
  substitutedFrom?: CatalogExercise;
  reason?: string;
}

export interface AdaptedRoutine {
  title: string;
  note: string | null;
  fromHandle: string | null;
  items: AdaptedExercise[];
  /** Ids to hand to `startRoutine`, substitutions applied, gaps removed. */
  startIds: string[];
  substitutions: number;
  unavailable: number;
}

export interface AdaptContext {
  /** Local catalog lookup. Null for an id this build does not know. */
  lookup: (id: string) => CatalogExercise | null;
  /**
   * Ranked substitutes for an id, best first, already re-ranked for this user.
   *
   * Supplied by the data layer rather than queried here, because the similarity
   * matrix lives in SQLite and this module must stay reachable from Node tests.
   */
  alternatives: (id: string) => readonly CatalogExercise[];
  /**
   * Equipment this person can actually reach. Empty means "assume everything",
   * matching `RerankContext` — a user who has not told us their gym should not
   * have their friend's routine quietly rewritten.
   */
  availableLoadTypes?: readonly LoadType[];
}

function canRun(exercise: CatalogExercise, available: readonly LoadType[]): boolean {
  if (available.length === 0) return true;
  return available.includes(exercise.loadType);
}

/**
 * Rewrite a received routine into one this person can run today.
 *
 * The case that makes this worth building: a friend sends you their session, it
 * opens with a barbell hip thrust, and your gym has no barbell. Every other app
 * hands you a routine with a hole in it and leaves you to fix it mid-workout.
 * Shift already ships the similarity matrix that answers "what else trains
 * this" — so the hole is filled before you ever see it, and the card says what
 * it replaced.
 *
 * A substitution is never silent. `substitutedFrom` and `reason` exist so the
 * UI can show the original: a routine that quietly becomes a different routine
 * is worse than one with a gap, because you cannot tell it happened.
 */
export function adaptRoutine(routine: SharedRoutine, ctx: AdaptContext): AdaptedRoutine {
  const available = ctx.availableLoadTypes ?? [];
  const items: AdaptedExercise[] = [];
  const startIds: string[] = [];
  let substitutions = 0;
  let unavailable = 0;

  for (const requested of routine.exercises) {
    const local = ctx.lookup(requested.exerciseId);

    if (local && canRun(local, available)) {
      items.push({ status: 'kept', requested, exercise: local });
      startIds.push(local.id);
      continue;
    }

    // Either the id is unknown to this catalog, or it needs equipment this
    // person does not have. Both are answered the same way: find the closest
    // thing they *can* do.
    const candidate = ctx.alternatives(requested.exerciseId).find((alt) => canRun(alt, available));

    if (candidate) {
      const item: AdaptedExercise = {
        status: 'substituted',
        requested,
        exercise: candidate,
        reason: local
          ? `No ${local.loadType} available — closest match by muscle and pattern`
          : 'Not in your catalog — closest match by muscle and pattern',
      };
      if (local) item.substitutedFrom = local;
      items.push(item);
      startIds.push(candidate.id);
      substitutions++;
      continue;
    }

    items.push({
      status: 'unavailable',
      requested,
      exercise: null,
      reason: 'Nothing in your catalog trains this with the equipment you have',
    });
    unavailable++;
  }

  return {
    title: routine.title,
    note: routine.note,
    fromHandle: routine.fromHandle,
    items,
    startIds,
    substitutions,
    unavailable,
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * A routine as a link, so it can be sent through any messenger.
 *
 * In-app sharing needs both people to have accounts and to be friends. A link
 * needs neither, which is the difference between "send this to your training
 * partner" and "send this to your training partner *after* they sign up".
 *
 * The encoding is a compact positional form rather than base64'd JSON: JSON of
 * a ten-exercise routine is around 900 bytes and base64 inflates it by a third,
 * which produces a link nobody wants to paste. Names are dropped — the receiver
 * resolves them from their own catalog — which is most of the saving.
 */
const LINK_PREFIX = 'shift://routine/';

export function encodeRoutineLink(routine: SharedRoutine): string {
  const body = routine.exercises
    .map((e) => [e.exerciseId, e.sets, e.reps, e.restS ?? ''].join(':'))
    .join(',');

  const payload = [
    String(SHARE_VERSION),
    encodeURIComponent(routine.title),
    encodeURIComponent(routine.note ?? ''),
    body,
  ].join('|');

  return LINK_PREFIX + base64UrlEncode(payload);
}

export function decodeRoutineLink(url: string): SharedRoutine | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(LINK_PREFIX)) return null;

  const decoded = base64UrlDecode(trimmed.slice(LINK_PREFIX.length));
  if (decoded === null) return null;

  const [version, title, note, body] = decoded.split('|');
  if (version !== String(SHARE_VERSION) || body === undefined) return null;

  const exercises: SharedExercise[] = [];
  for (const chunk of body.split(',')) {
    if (!chunk) continue;
    const [id, sets, reps, rest] = chunk.split(':');
    if (!id || !isPlausibleExerciseId(id)) return null;

    const shared: SharedExercise = {
      exerciseId: id,
      // Resolved from the receiver's catalog. A link is not a place to trust a
      // display string from: it is pasted from a chat app by definition.
      name: '',
      sets: clampInt(Number(sets), 1, MAX_SETS, 3),
      reps: clampInt(Number(reps), 1, MAX_REPS, 8),
    };
    if (rest) shared.restS = clampInt(Number(rest), 0, MAX_REST_S, 0);
    exercises.push(shared);

    if (exercises.length > MAX_SHARED_EXERCISES) return null;
  }

  if (exercises.length === 0) return null;

  return {
    version: SHARE_VERSION,
    title: safeDecodeComponent(title) || 'Shared workout',
    note: safeDecodeComponent(note) || null,
    exercises,
    fromHandle: null,
    createdAt: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url, hand-rolled.
 *
 * Hermes ships no `btoa`/`atob` and `Buffer` is a Node global, so anything
 * borrowed from either runtime would work in exactly one of the two places this
 * module has to run. A short table lookup is cheaper than a dependency or a
 * polyfill, and the round trip is asserted in the tests.
 *
 * No `=` padding: the length is recoverable from the character count, and an
 * unpadded string survives being pasted into a URL bar without escaping.
 */
function base64UrlEncode(input: string): string {
  const bytes = utf8Bytes(input);
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64[c & 63];
  }
  return out;
}

function base64UrlDecode(input: string): string | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of input) {
    const value = B64.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return utf8String(bytes);
}

function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return out;
}

function utf8String(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    let code: number;
    let size: number;

    if (byte < 0x80) {
      code = byte;
      size = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      code = byte & 31;
      size = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      code = byte & 15;
      size = 3;
    } else {
      code = byte & 7;
      size = 4;
    }

    for (let k = 1; k < size; k++) {
      const next = bytes[i + k];
      if (next === undefined) return out;
      code = (code << 6) | (next & 63);
    }
    out += String.fromCodePoint(code);
    i += size;
  }
  return out;
}

function safeDecodeComponent(input: string | undefined): string {
  if (!input) return '';
  try {
    return decodeURIComponent(input);
  } catch {
    // A malformed percent-escape in a pasted link should cost the title, not
    // the routine.
    return '';
  }
}

/** Catalog ids are short opaque strings. Anything else is not one. */
function isPlausibleExerciseId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,24}$/.test(id);
}

function trimTo(input: string, max: number): string {
  return input.trim().slice(0, max);
}

function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}
