import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogExercise, LoadType, MovementPattern } from '../src/domain/catalog.ts';
import { rerankAlternatives } from '../src/domain/catalog.ts';
import {
  buildSimilarityMatrix,
  COMPOUND_MISMATCH_PENALTY,
  nameOverlap,
  redundancy,
  scoreSimilarity,
} from '../src/domain/similarity.ts';
import { MUSCLE_MAP, MUSCLE_REGION, canonicalMuscle } from '../scripts/catalog/muscles.ts';
import { canonicalEquipment, EQUIPMENT_MAP } from '../scripts/catalog/equipment.ts';
import {
  classifyPattern,
  PATTERN_FAMILY,
  PATTERN_PLANE,
  isUnilateral,
} from '../scripts/catalog/patterns.ts';
import { variantKey } from '../scripts/catalog/normalize.ts';

const regionOf = (m: CatalogExercise['target']) => MUSCLE_REGION[m];

let seq = 0;
function ex(over: Partial<CatalogExercise> = {}): CatalogExercise {
  const name = over.name ?? `exercise ${seq}`;
  return {
    id: String(seq++).padStart(4, '0'),
    name,
    bodyPart: 'chest',
    rawTarget: 'pectorals',
    rawEquipment: 'barbell',
    target: 'pectorals',
    secondary: ['triceps', 'delts'],
    variantKey: name,
    pattern: 'horizontal_push',
    family: 'push_horizontal',
    plane: 'transverse',
    loadType: 'barbell',
    isCompound: true,
    isUnilateral: false,
    stability: 2,
    skill: 1,
    classification: 'rule',
    image: null,
    gifUrl: null,
    instructions: null,
    attribution: '',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test('the muscle map covers every string the dataset uses', () => {
  // The exact union observed across target, muscle_group and secondary_muscles
  // in all 1,324 records. The build hard-fails on anything outside this set.
  const observed = [
    'abdominals', 'abductors', 'abs', 'adductors', 'ankle stabilizers', 'ankles', 'back',
    'biceps', 'brachialis', 'calves', 'cardiovascular system', 'chest', 'core', 'deltoids',
    'delts', 'feet', 'forearms', 'glutes', 'grip muscles', 'groin', 'hamstrings', 'hands',
    'hip flexors', 'inner thighs', 'latissimus dorsi', 'lats', 'levator scapulae', 'lower abs',
    'lower back', 'obliques', 'pectorals', 'quadriceps', 'quads', 'rear deltoids', 'rhomboids',
    'rotator cuff', 'serratus anterior', 'shins', 'shoulders', 'soleus', 'spine',
    'sternocleidomastoid', 'trapezius', 'traps', 'triceps', 'upper back', 'upper chest',
    'wrist extensors', 'wrist flexors', 'wrists',
  ];
  assert.equal(observed.length, 50);
  for (const raw of observed) {
    assert.ok(canonicalMuscle(raw) !== null, `"${raw}" is unmapped`);
  }
});

test('aliases across the three muscle fields collapse to one canonical value', () => {
  assert.equal(canonicalMuscle('traps'), canonicalMuscle('trapezius'));
  assert.equal(canonicalMuscle('lats'), canonicalMuscle('latissimus dorsi'));
  assert.equal(canonicalMuscle('quads'), canonicalMuscle('quadriceps'));
  assert.equal(canonicalMuscle('delts'), canonicalMuscle('deltoids'));
  assert.equal(canonicalMuscle('delts'), canonicalMuscle('shoulders'));
  assert.equal(canonicalMuscle('abs'), canonicalMuscle('abdominals'));
});

test('rear delts stay distinct from delts — they are not interchangeable', () => {
  assert.notEqual(canonicalMuscle('rear deltoids'), canonicalMuscle('deltoids'));
});

test('every canonical muscle has a region', () => {
  for (const canon of new Set(Object.values(MUSCLE_MAP))) {
    assert.ok(MUSCLE_REGION[canon] !== undefined, `${canon} has no region`);
  }
});

test('the equipment map covers all 28 dataset values and is total', () => {
  assert.equal(Object.keys(EQUIPMENT_MAP).length, 28);
  for (const raw of Object.keys(EQUIPMENT_MAP)) {
    const spec = canonicalEquipment(raw)!;
    assert.ok(spec.stability >= 0 && spec.stability <= 2);
  }
  assert.equal(canonicalEquipment('jetpack'), null, 'unknown kit must fail loudly');
});

test('free weights, cables and machines are ordered by stabilisation demand', () => {
  const free = canonicalEquipment('barbell')!.stability;
  const cable = canonicalEquipment('cable')!.stability;
  const machine = canonicalEquipment('leverage machine')!.stability;
  assert.ok(free > cable && cable > machine);
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('"curl" resolves by target, not by name alone', () => {
  assert.equal(classifyPattern({ name: 'dumbbell bicep curl', target: 'biceps', bodyPart: 'upper arms' }).pattern, 'elbow_flexion');
  assert.equal(classifyPattern({ name: 'lever leg curl', target: 'hamstrings', bodyPart: 'upper legs' }).pattern, 'knee_flexion');
  assert.equal(classifyPattern({ name: 'barbell wrist curl', target: 'forearms', bodyPart: 'lower arms' }).pattern, 'wrist_flexion');
});

test('mobility work is never classified as strength', () => {
  const c = classifyPattern({ name: 'standing hamstring stretch', target: 'hamstrings', bodyPart: 'upper legs' });
  assert.equal(c.pattern, 'stretch');
});

test('regression: names that previously fell through to the wrong pattern', () => {
  const cases: [string, CatalogExercise['target'], MovementPattern][] = [
    // "rack pull" contains "pull" and was swept into hip_extension.
    ['barbell rack pull', 'glutes', 'hinge'],
    ['band pull through', 'glutes', 'hinge'],
    // The dataset spells it "rollerout"; "rollout" alone missed these, and
    // "barbell rollerout from bench" reached horizontal_push via "bench".
    ['barbell rollerout', 'abs', 'anti_extension'],
    ['barbell rollerout from bench', 'abs', 'anti_extension'],
    // Rear-delt work whose target field says plain "delts".
    ['band reverse fly', 'delts', 'shoulder_horizontal_abduction'],
    // Side bends are frontal-plane lateral flexion, not a crunch.
    ['45° side bend', 'abs', 'lateral_flexion'],
  ];
  for (const [name, target, expected] of cases) {
    const got = classifyPattern({ name, target, bodyPart: 'x' }).pattern;
    assert.equal(got, expected, `"${name}" classified as ${got}`);
  }
});

test('unmatched names fall back to the target and are marked as such', () => {
  const c = classifyPattern({ name: 'balance board', target: 'quads', bodyPart: 'upper legs' });
  assert.equal(c.source, 'target-fallback');
  assert.ok(c.pattern);
});

test('every movement pattern has a family and a plane', () => {
  for (const pattern of Object.keys(PATTERN_FAMILY) as MovementPattern[]) {
    assert.ok(PATTERN_PLANE[pattern] !== undefined, `${pattern} has no plane`);
  }
  assert.equal(
    Object.keys(PATTERN_FAMILY).length,
    Object.keys(PATTERN_PLANE).length,
    'family and plane tables must stay in step',
  );
});

test('unilateral detection reads the name', () => {
  assert.ok(isUnilateral('dumbbell one arm row'));
  assert.ok(isUnilateral('single leg deadlift'));
  assert.ok(isUnilateral('dumbbell alternating curl'));
  assert.ok(!isUnilateral('barbell bench press'));
});

// ---------------------------------------------------------------------------
// Variant handling
// ---------------------------------------------------------------------------

test('media variants of one movement collapse to a single key', () => {
  const base = variantKey('barbell full squat');
  assert.equal(variantKey('barbell full squat (back pov)'), base);
  assert.equal(variantKey('barbell full squat (male)'), base);
  assert.equal(variantKey('barbell upright row v. 2'), variantKey('barbell upright row'));
  assert.notEqual(variantKey('barbell front squat'), base, 'real variations stay distinct');
});

test('an exercise is never offered as an alternative to its own media variant', () => {
  const a = ex({ name: 'barbell full squat', variantKey: 'barbell full squat' });
  const b = ex({ name: 'barbell full squat (back pov)', variantKey: 'barbell full squat' });
  assert.equal(scoreSimilarity(a, b, regionOf), null);
});

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

test('an identical configuration scores a perfect match', () => {
  const a = ex({ name: 'a' });
  const b = ex({ name: 'b' });
  assert.equal(scoreSimilarity(a, b, regionOf)!.score, 1);
});

test('an exercise is never its own alternative', () => {
  const a = ex();
  assert.equal(scoreSimilarity(a, a, regionOf), null);
});

test('a compound is penalised as a substitute for an isolation', () => {
  const press = ex({ name: 'bench press', isCompound: true });
  const fly = ex({ name: 'cable fly', isCompound: false });
  const withMismatch = scoreSimilarity(press, fly, regionOf)!.score;
  const withoutMismatch = scoreSimilarity(press, ex({ name: 'other press' }), regionOf)!.score;
  assert.ok(
    withoutMismatch - withMismatch >= COMPOUND_MISMATCH_PENALTY - 1e-9,
    'bench press -> cable fly must not rank alongside a true substitute',
  );
});

test('stretches and cardio never substitute for strength work', () => {
  const squat = ex({ name: 'squat', pattern: 'squat', family: 'knee', target: 'quads' });
  const stretch = ex({ name: 'quad stretch', pattern: 'stretch', family: 'stretch', target: 'quads' });
  const cardio = ex({ name: 'bike', pattern: 'cardio', family: 'cardio', target: 'cardio' });

  assert.equal(scoreSimilarity(squat, stretch, regionOf), null);
  assert.equal(scoreSimilarity(squat, cardio, regionOf), null);
  assert.ok(
    scoreSimilarity(stretch, ex({ name: 'ham stretch', pattern: 'stretch', family: 'stretch', target: 'quads' }), regionOf) !== null,
    'a stretch may still substitute for another stretch',
  );
});

test('unrelated exercises are excluded rather than scored low', () => {
  const bench = ex();
  const calf = ex({
    name: 'calf raise', target: 'calves', bodyPart: 'lower legs',
    pattern: 'calf_raise', family: 'calf', secondary: [],
  });
  assert.equal(scoreSimilarity(bench, calf, regionOf), null);
});

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

test('name overlap catches variations that structured fields cannot', () => {
  assert.ok(nameOverlap('barbell bench press', 'barbell incline bench press') > 0.5);
  assert.equal(nameOverlap('barbell bench press', 'cable crossover'), 0);
});

test('needing different equipment makes a candidate less redundant', () => {
  const barbell = ex({ name: 'barbell bench press', loadType: 'barbell' });
  const sameKit = ex({ name: 'barbell incline bench press', loadType: 'barbell' });
  const otherKit = ex({ name: 'dumbbell bench press', loadType: 'dumbbell' });

  assert.ok(
    redundancy(barbell, otherKit, regionOf) < redundancy(barbell, sameKit, regionOf),
    'a dumbbell version answers "the bench is taken"; another barbell version does not',
  );
});

test('regression: top-K spans equipment instead of enumerating one movement', () => {
  // Mirrors the real failure: many biomechanically identical chest presses, all
  // scoring 1.000, where pure relevance ranking returned twelve bench presses.
  const kit: LoadType[] = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];
  const pool: CatalogExercise[] = [];
  for (const loadType of kit) {
    for (let i = 0; i < 20; i++) {
      pool.push(ex({ name: `${loadType} bench press variation ${i}`, loadType }));
    }
  }

  const rows = buildSimilarityMatrix(pool, regionOf, 12);
  const first = pool[0]!;
  const top = rows.filter((r) => r.exerciseId === first.id);
  const byId = new Map(pool.map((e) => [e.id, e]));
  const types = new Set(top.map((r) => byId.get(r.altId)!.loadType));

  assert.equal(top.length, 12);
  assert.ok(types.size >= 4, `top-12 covered only ${types.size} load types: ${[...types]}`);
});

test('rank is selection order, and the best match is still rank 0', () => {
  const pool = [ex({ name: 'a' }), ex({ name: 'b' }), ex({ name: 'c', loadType: 'cable', stability: 1 })];
  const rows = buildSimilarityMatrix(pool, regionOf, 3);
  const top = rows.filter((r) => r.exerciseId === pool[0]!.id);
  assert.equal(top[0]!.rank, 0);
  assert.ok(top[0]!.score >= top[top.length - 1]!.score);
});

// ---------------------------------------------------------------------------
// Runtime re-ranking
// ---------------------------------------------------------------------------

test('re-ranking drops what is already in the workout or blocked', () => {
  const a = ex({ name: 'a' });
  const b = ex({ name: 'b' });
  const c = ex({ name: 'c' });
  const candidates = [a, b, c].map((e) => ({
    exercise: e,
    score: 1,
    reason: { target: 1, pattern: 1, secondary: 1, plane: 1, unilateral: 1, stability: 1 },
  }));

  const ranked = rerankAlternatives(candidates, {
    availableLoadTypes: [],
    hasHistory: new Set(),
    inWorkout: new Set([a.id]),
    patternsToday: new Set(),
    blocked: new Set([b.id]),
  });

  assert.deepEqual(ranked.map((r) => r.exercise.id), [c.id]);
});

test('re-ranking preserves the build-time diversity order when nothing overrides it', () => {
  // The regression that mattered: half of all similarity rows tie at 1.000, so
  // sorting by score pulls the near-duplicates MMR pushed to the back straight
  // back to the front. A lat pulldown returned five cable pulldowns.
  const ordered = ['cable', 'band', 'bodyweight', 'machine', 'barbell'].map((loadType, i) =>
    ex({ name: `${loadType} pulldown`, loadType: loadType as LoadType }),
  );
  const candidates = ordered.map((e, i) => ({
    exercise: e,
    // Deliberately non-monotonic: rank 0 scores lower than later entries.
    score: i === 0 ? 0.9 : 1,
    reason: { target: 1, pattern: 1, secondary: 1, plane: 1, unilateral: 1, stability: 1 },
  }));

  const ranked = rerankAlternatives(candidates);
  assert.deepEqual(
    ranked.map((r) => r.exercise.loadType),
    ['cable', 'band', 'bodyweight', 'machine', 'barbell'],
    'rank order must survive a higher-scoring later candidate',
  );
});

test('re-ranking prefers exercises Shift can already predict a weight for', () => {
  const known = ex({ name: 'known' });
  const unknown = ex({ name: 'unknown' });
  const candidates = [unknown, known].map((e) => ({
    exercise: e,
    score: 0.9,
    reason: { target: 1, pattern: 1, secondary: 1, plane: 1, unilateral: 1, stability: 1 },
  }));

  const ranked = rerankAlternatives(candidates, {
    availableLoadTypes: [],
    hasHistory: new Set([known.id]),
    inWorkout: new Set(),
    patternsToday: new Set(),
    blocked: new Set(),
  });

  assert.equal(ranked[0]!.exercise.id, known.id);
  assert.match(ranked[0]!.explanation, /history/);
});

test('unavailable equipment is demoted but not removed', () => {
  const available = ex({ name: 'dumbbell version', loadType: 'dumbbell' });
  const unavailable = ex({ name: 'machine version', loadType: 'machine' });
  const candidates = [unavailable, available].map((e) => ({
    exercise: e,
    score: 1,
    reason: { target: 1, pattern: 1, secondary: 1, plane: 1, unilateral: 1, stability: 1 },
  }));

  const ranked = rerankAlternatives(candidates, {
    availableLoadTypes: ['dumbbell'],
    hasHistory: new Set(),
    inWorkout: new Set(),
    patternsToday: new Set(),
    blocked: new Set(),
  });

  assert.equal(ranked[0]!.exercise.id, available.id);
  assert.equal(ranked.length, 2, 'a poor option still beats no option');
});

test('a pattern already trained today is a worse substitute', () => {
  const fresh = ex({ name: 'fresh', pattern: 'chest_fly', family: 'push_horizontal', isCompound: false });
  const repeat = ex({ name: 'repeat', pattern: 'horizontal_push' });
  const candidates = [repeat, fresh].map((e) => ({
    exercise: e,
    score: 0.9,
    reason: { target: 1, pattern: 1, secondary: 1, plane: 1, unilateral: 1, stability: 1 },
  }));

  const ranked = rerankAlternatives(candidates, {
    availableLoadTypes: [],
    hasHistory: new Set(),
    inWorkout: new Set(),
    patternsToday: new Set(['horizontal_push']),
    blocked: new Set(),
  });

  assert.equal(ranked[0]!.exercise.id, fresh.id);
});
