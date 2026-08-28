import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogExercise, LoadType } from '../src/domain/catalog.ts';
import {
  adaptRoutine,
  decodeRoutineLink,
  encodeRoutineLink,
  MAX_SHARED_EXERCISES,
  parseSharedRoutine,
  routineFromSession,
  shareOneExercise,
  SHARE_VERSION,
  type SharedRoutine,
} from '../src/domain/sharing.ts';

const NOW = '2026-08-28T09:00:00.000Z';

function exercise(id: string, name: string, loadType: LoadType): CatalogExercise {
  return {
    id,
    name,
    bodyPart: 'upper legs',
    rawTarget: 'glutes',
    rawEquipment: loadType,
    target: 'glutes',
    secondary: ['hamstrings'],
    variantKey: name,
    pattern: 'hip_extension',
    family: 'hip',
    plane: 'sagittal',
    loadType,
    isCompound: true,
    isUnilateral: false,
    stability: 2,
    skill: 1,
    classification: 'rule',
    image: null,
    gifUrl: null,
    instructions: null,
    attribution: '© Gym visual',
  };
}

const HIP_THRUST = exercise('0100', 'barbell hip thrust', 'barbell');
const GLUTE_BRIDGE = exercise('0200', 'dumbbell glute bridge', 'dumbbell');
const CABLE_PULL = exercise('0300', 'cable pull through', 'cable');

function session() {
  return [
    {
      exerciseId: '0043',
      name: 'barbell full squat',
      sets: [
        { reps: 10, completed: true, weightKg: 100 },
        { reps: 8, completed: true, weightKg: 110 },
        { reps: 8, completed: false, weightKg: 110 },
      ],
    },
    {
      exerciseId: '0025',
      name: 'barbell bench press',
      sets: [
        { reps: 5, completed: true, weightKg: 80 },
        { reps: 5, completed: false, weightKg: 80 },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

test('a shared routine carries no load anywhere in its payload', () => {
  const routine = routineFromSession({ title: 'Leg day', exercises: session(), now: NOW });
  const wire = JSON.stringify(routine);

  // Not "no field named weight" — no trace of the actual numbers lifted. If a
  // future field ever smuggles one across, this catches it whatever it is called.
  for (const load of ['100', '110', '80']) {
    assert.equal(wire.includes(load), false, `payload leaked the ${load} kg lifted`);
  }
});

test('a payload cannot smuggle a weight back in through an unknown field', () => {
  const hostile = {
    version: SHARE_VERSION,
    title: 'Leg day',
    exercises: [{ exerciseId: '0043', name: 'squat', sets: 3, reps: 8, weightKg: 140 }],
  };

  const parsed = parseSharedRoutine(hostile);
  assert.equal(parsed.ok, true);
  assert.equal(JSON.stringify(parsed.ok && parsed.routine).includes('140'), false);
});

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

test('the rep count that travels is the one a human would have written down', () => {
  // 10/8/8 is "three sets of eight", not three sets of 8.67.
  const routine = routineFromSession({ title: 'Leg day', exercises: session(), now: NOW });
  assert.equal(routine.exercises[0]!.reps, 8);
  assert.equal(routine.exercises[0]!.sets, 3);
});

test('sharing what was done drops the sets that were not', () => {
  const routine = routineFromSession({
    title: 'Leg day',
    exercises: session(),
    completedOnly: true,
    now: NOW,
  });
  assert.equal(routine.exercises[0]!.sets, 2);
  assert.equal(routine.exercises[1]!.sets, 1);
});

test('an exercise with nothing completed does not appear in a shared session', () => {
  const routine = routineFromSession({
    title: 'Leg day',
    exercises: [{ exerciseId: '0043', name: 'squat', sets: [{ reps: 8, completed: false }] }],
    completedOnly: true,
    now: NOW,
  });
  assert.deepEqual(routine.exercises, []);
});

test('a routine longer than the cap is truncated rather than rejected', () => {
  const many = Array.from({ length: MAX_SHARED_EXERCISES + 6 }, (_, i) => ({
    exerciseId: `id${i}`,
    name: `exercise ${i}`,
    sets: [{ reps: 8 }],
  }));
  const routine = routineFromSession({ title: 'Everything', exercises: many, now: NOW });
  assert.equal(routine.exercises.length, MAX_SHARED_EXERCISES);
});

test('a single exercise is a one-item routine, not a separate shape', () => {
  const routine = shareOneExercise({ id: '0100', name: 'barbell hip thrust' }, { sets: 4, reps: 12, now: NOW });
  assert.equal(routine.exercises.length, 1);
  assert.equal(routine.exercises[0]!.sets, 4);
  assert.equal(routine.exercises[0]!.reps, 12);
  assert.equal(routine.title, 'barbell hip thrust');
});

// ---------------------------------------------------------------------------
// Parsing what someone else wrote
// ---------------------------------------------------------------------------

test('anything that is not a routine object is refused', () => {
  for (const input of [null, 42, 'routine', [], undefined]) {
    assert.equal(parseSharedRoutine(input).ok, false);
  }
});

test('a payload from a future version is refused rather than guessed at', () => {
  const result = parseSharedRoutine({ version: 99, title: 'x', exercises: [{ exerciseId: '1' }] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-version');
});

test('an empty routine and an oversized one are both refused', () => {
  assert.equal(parseSharedRoutine({ version: SHARE_VERSION, exercises: [] }).ok, false);

  const huge = {
    version: SHARE_VERSION,
    exercises: Array.from({ length: MAX_SHARED_EXERCISES + 1 }, () => ({ exerciseId: '0043' })),
  };
  const result = parseSharedRoutine(huge);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'too-many-exercises');
});

test('an exercise id that is not one is refused', () => {
  for (const id of ['', '../../etc/passwd', 'a'.repeat(40), 'has space', 42]) {
    const result = parseSharedRoutine({
      version: SHARE_VERSION,
      exercises: [{ exerciseId: id, sets: 3, reps: 8 }],
    });
    assert.equal(result.ok, false, `accepted ${String(id)}`);
  }
});

test('out-of-range numbers are clamped, because a bad field should not cost the routine', () => {
  const result = parseSharedRoutine({
    version: SHARE_VERSION,
    exercises: [{ exerciseId: '0043', sets: 9999, reps: -3, restS: 1e9 }],
  });
  assert.equal(result.ok, true);
  const first = result.ok && result.routine.exercises[0]!;
  assert.equal(first && first.sets, 20);
  assert.equal(first && first.reps, 1);
  assert.equal(first && first.restS, 900);
});

test('an over-long title is trimmed, not rejected', () => {
  const result = parseSharedRoutine({
    version: SHARE_VERSION,
    title: 'x'.repeat(500),
    exercises: [{ exerciseId: '0043' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.routine.title.length, 60);
});

test('a round trip through the parser preserves what was sent', () => {
  const built = routineFromSession({
    title: 'Leg day',
    note: 'go slow on the eccentric',
    fromHandle: 'ana',
    exercises: session(),
    now: NOW,
  });
  const result = parseSharedRoutine(JSON.parse(JSON.stringify(built)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.routine, built);
});

// ---------------------------------------------------------------------------
// Adapting it to the receiver
// ---------------------------------------------------------------------------

function ctx(known: CatalogExercise[], alternatives: CatalogExercise[], loadTypes?: LoadType[]) {
  return {
    lookup: (id: string) => known.find((e) => e.id === id) ?? null,
    alternatives: () => alternatives,
    ...(loadTypes ? { availableLoadTypes: loadTypes } : {}),
  };
}

function routine(ids: string[]): SharedRoutine {
  return {
    version: SHARE_VERSION,
    title: 'Glutes',
    note: null,
    fromHandle: 'ana',
    createdAt: NOW,
    exercises: ids.map((id) => ({ exerciseId: id, name: id, sets: 3, reps: 8 })),
  };
}

test('a routine you can run arrives unchanged', () => {
  const adapted = adaptRoutine(routine(['0100']), ctx([HIP_THRUST], [], ['barbell']));
  assert.equal(adapted.substitutions, 0);
  assert.equal(adapted.items[0]!.status, 'kept');
  assert.deepEqual(adapted.startIds, ['0100']);
});

test('saying nothing about your equipment leaves the routine alone', () => {
  // Empty means "assume everything". A user who has not told us their gym must
  // not have a friend's routine quietly rewritten under them.
  const adapted = adaptRoutine(routine(['0100']), ctx([HIP_THRUST], [GLUTE_BRIDGE]));
  assert.equal(adapted.substitutions, 0);
  assert.equal(adapted.items[0]!.exercise, HIP_THRUST);
});

test('an exercise your gym cannot do is swapped for the closest thing it can', () => {
  const adapted = adaptRoutine(
    routine(['0100']),
    ctx([HIP_THRUST], [CABLE_PULL, GLUTE_BRIDGE], ['dumbbell']),
  );
  assert.equal(adapted.substitutions, 1);

  const item = adapted.items[0]!;
  assert.equal(item.status, 'substituted');
  assert.equal(item.exercise, GLUTE_BRIDGE);
  // Never silent: the card has to be able to say what it replaced.
  assert.equal(item.substitutedFrom, HIP_THRUST);
  assert.match(item.reason ?? '', /barbell/);
  assert.deepEqual(adapted.startIds, ['0200']);
});

test('an exercise your catalog has never heard of is swapped too', () => {
  const adapted = adaptRoutine(routine(['9999']), ctx([], [GLUTE_BRIDGE], ['dumbbell']));
  assert.equal(adapted.items[0]!.status, 'substituted');
  assert.equal(adapted.items[0]!.substitutedFrom, undefined);
  assert.match(adapted.items[0]!.reason ?? '', /catalog/);
});

test('when nothing can replace it the gap is reported, not hidden', () => {
  const adapted = adaptRoutine(routine(['0100']), ctx([HIP_THRUST], [CABLE_PULL], ['bodyweight']));
  assert.equal(adapted.unavailable, 1);
  assert.equal(adapted.items[0]!.status, 'unavailable');
  assert.equal(adapted.items[0]!.exercise, null);
  // The unrunnable exercise must not reach the workout screen.
  assert.deepEqual(adapted.startIds, []);
});

test('a mixed routine reports how much of it survived', () => {
  const adapted = adaptRoutine(
    routine(['0100', '0200', '0300']),
    ctx([HIP_THRUST, GLUTE_BRIDGE, CABLE_PULL], [GLUTE_BRIDGE], ['dumbbell']),
  );
  assert.equal(adapted.substitutions, 2);
  assert.equal(adapted.unavailable, 0);
  assert.deepEqual(adapted.startIds, ['0200', '0200', '0200']);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test('a routine survives a round trip through a link', () => {
  const built = routineFromSession({
    title: 'Pernas de terça',
    note: 'devagar na descida',
    exercises: session(),
    now: NOW,
  });

  const decoded = decodeRoutineLink(encodeRoutineLink(built));
  assert.notEqual(decoded, null);
  assert.equal(decoded!.title, 'Pernas de terça');
  assert.equal(decoded!.note, 'devagar na descida');
  assert.equal(decoded!.exercises.length, 2);
  assert.equal(decoded!.exercises[0]!.exerciseId, '0043');
  assert.equal(decoded!.exercises[0]!.reps, 8);
});

test('a prescribed rest survives a link and an absent one stays absent', () => {
  const built = routineFromSession({
    title: 'x',
    exercises: [
      { exerciseId: '0043', name: 'squat', sets: [{ reps: 5 }], restS: 240 },
      { exerciseId: '0025', name: 'bench', sets: [{ reps: 5 }] },
    ],
    now: NOW,
  });

  const decoded = decodeRoutineLink(encodeRoutineLink(built))!;
  assert.equal(decoded.exercises[0]!.restS, 240);
  assert.equal(decoded.exercises[1]!.restS, undefined);
});

test('the link stays short enough to paste into a chat', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    exerciseId: `0${100 + i}`,
    name: 'a reasonably long exercise name here',
    sets: [{ reps: 8 }, { reps: 8 }, { reps: 8 }],
  }));
  const built = routineFromSession({ title: 'Full body', exercises: ten, now: NOW });

  const link = encodeRoutineLink(built);
  // The compact form exists precisely to beat base64'd JSON. If it ever stops
  // doing so, the extra parser is not paying for itself.
  assert.ok(link.length < JSON.stringify(built).length, `link was ${link.length} chars`);
  assert.ok(link.length < 400, `link was ${link.length} chars`);
});

test('a link that is not one, or is damaged, decodes to nothing rather than throwing', () => {
  for (const url of [
    'https://example.com/routine/abc',
    'shift://squad/A3F9K2',
    'shift://routine/',
    'shift://routine/!!!!',
    'shift://routine/aaaa',
    '',
  ]) {
    assert.equal(decodeRoutineLink(url), null, `accepted ${url}`);
  }
});

test('a link carrying a hostile exercise id decodes to nothing', () => {
  const link = encodeRoutineLink({
    version: SHARE_VERSION,
    title: 'x',
    note: null,
    fromHandle: null,
    createdAt: NOW,
    exercises: [{ exerciseId: '../secrets', name: '', sets: 3, reps: 8 }],
  });
  assert.equal(decodeRoutineLink(link), null);
});

test('a link never carries a display name, because a pasted string is not evidence', () => {
  const built = routineFromSession({
    title: 'x',
    exercises: [{ exerciseId: '0043', name: 'barbell full squat', sets: [{ reps: 5 }] }],
    now: NOW,
  });
  const decoded = decodeRoutineLink(encodeRoutineLink(built))!;
  assert.equal(decoded.exercises[0]!.name, '');
});
