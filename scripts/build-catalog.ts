/**
 * Shift catalog build.
 *
 *   node scripts/build-catalog.ts [--strict]
 *
 * Reads the raw dataset, canonicalises it, derives the biomechanical fields the
 * source does not have, precomputes the similarity matrix, and emits the bundled
 * SQLite asset plus a Postgres seed.
 *
 * Runs offline; its outputs are committed. Nothing in this file executes on a
 * device — the runtime only ever opens the finished database.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MUSCLE_REGION } from './catalog/muscles.ts';
import { emitPostgresSeed, emitSqlite } from './catalog/emit.ts';
import { normalizeAll } from './catalog/normalize.ts';
import type { Override, RawExercise } from './catalog/normalize.ts';
import { buildSimilarityMatrix, DEFAULT_TOP_K } from '../src/domain/similarity.ts';
import type { CanonicalMuscle } from '../src/domain/catalog.ts';

const RAW = 'data/raw/exercises.json';
const OVERRIDES = 'data/overrides.json';
const DB_OUT = 'assets/catalog.db';
const META_OUT = 'assets/catalog-meta.json';
const SEED_OUT = 'data/seed/catalog.sql';
const SOURCE = 'https://github.com/hasaneyldrm/exercises-dataset';

/**
 * Minimum share of exercises whose pattern comes from a name rule rather than a
 * target fallback. A fallback is a guess about the movement; too many of them
 * and the swap suggestions quietly become target-only matching, which is the
 * exact failure this pipeline exists to prevent.
 */
const MIN_RULE_COVERAGE = 0.75;

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

function main(): void {
  const strict = process.argv.includes('--strict');

  if (!existsSync(RAW)) {
    console.error(`Missing ${RAW}. Fetch it first:\n  node scripts/fetch-dataset.ts`);
    process.exit(1);
  }

  const rows = JSON.parse(readFileSync(RAW, 'utf8')) as RawExercise[];
  // Keys starting with "_" are documentation, not overrides.
  const overrides: Record<string, Override> = Object.fromEntries(
    Object.entries(
      existsSync(OVERRIDES) ? (JSON.parse(readFileSync(OVERRIDES, 'utf8')) as Record<string, Override>) : {},
    ).filter(([k]) => !k.startsWith('_')),
  );

  console.log(`Shift catalog build\n  source ${rows.length} exercises`);
  if (Object.keys(overrides).length > 0) {
    console.log(`  overrides ${Object.keys(overrides).length}`);
  }

  const { exercises, errors, stats } = normalizeAll(rows, overrides);

  // Unmapped vocabulary is a hard stop, not a warning. A new muscle or piece of
  // equipment appearing upstream must be a human decision — silently dropping it
  // would degrade every swap that touches it, invisibly.
  if (errors.length > 0) {
    console.error(`\n${errors.length} normalisation errors:`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    if (errors.length > 20) console.error(`  … and ${errors.length - 20} more`);
    if (stats.unmappedMuscles.size > 0) {
      console.error(`\n  Add to MUSCLE_MAP: ${[...stats.unmappedMuscles.keys()].join(', ')}`);
    }
    if (stats.unmappedEquipment.size > 0) {
      console.error(`  Add to EQUIPMENT_MAP: ${[...stats.unmappedEquipment.keys()].join(', ')}`);
    }
    process.exit(1);
  }

  const ruled = stats.byClassification['rule'] ?? 0;
  const fallback = stats.byClassification['target-fallback'] ?? 0;
  const overridden = stats.byClassification['override'] ?? 0;
  const coverage = (ruled + overridden) / exercises.length;

  console.log(`\n  classified ${exercises.length}`);
  console.log(`    by name rule      ${ruled} (${pct(ruled, exercises.length)})`);
  console.log(`    by target fallback ${fallback} (${pct(fallback, exercises.length)})`);
  if (overridden) console.log(`    by override        ${overridden}`);

  const patterns = new Map<string, number>();
  for (const e of exercises) patterns.set(e.pattern, (patterns.get(e.pattern) ?? 0) + 1);
  console.log(`  ${patterns.size} distinct movement patterns`);

  if (coverage < MIN_RULE_COVERAGE) {
    const msg =
      `Rule coverage ${pct(ruled + overridden, exercises.length)} is below the ` +
      `${(MIN_RULE_COVERAGE * 100).toFixed(0)}% floor. Add rules or overrides.`;
    if (strict) {
      console.error(`\n${msg}`);
      listWeakest(exercises);
      process.exit(1);
    }
    console.warn(`\nWARNING: ${msg}`);
    listWeakest(exercises);
  }

  const regionOf = (m: CanonicalMuscle) => MUSCLE_REGION[m];
  const t0 = Date.now();
  const similarity = buildSimilarityMatrix(exercises, regionOf, DEFAULT_TOP_K);
  console.log(`\n  similarity ${similarity.length} rows in ${Date.now() - t0}ms`);

  const orphans = exercises.filter((e) => !similarity.some((s) => s.exerciseId === e.id));
  if (orphans.length > 0) {
    console.log(`  ${orphans.length} exercises have no alternatives (expected for rare targets)`);
  }

  const builtAt = new Date().toISOString();
  // Compact, filename-safe build id. The app copies the bundled database into
  // writable storage under this name, so a rebuilt catalog lands at a new path
  // and can never be shadowed by a stale copy from a previous install.
  const version = builtAt.replace(/[-:]/g, '').replace(/\..+$/, '');

  const db = emitSqlite(DB_OUT, exercises, similarity, {
    built_at: builtAt,
    version,
    source: SOURCE,
    exercise_count: String(exercises.length),
    top_k: String(DEFAULT_TOP_K),
    rule_coverage: coverage.toFixed(4),
    attribution: exercises[0]?.attribution ?? '',
  });
  const seedBytes = emitPostgresSeed(SEED_OUT, exercises, similarity);

  writeFileSync(
    META_OUT,
    `${JSON.stringify(
      { version, builtAt, exerciseCount: exercises.length, topK: DEFAULT_TOP_K },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n  ${DB_OUT}  ${(db.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  ${SEED_OUT}  ${(seedBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('\nDone.');
}

/** Show the target fallbacks so the next batch of rules can be aimed at real cases. */
function listWeakest(exercises: readonly { name: string; classification: string }[]): void {
  const weak = exercises.filter((e) => e.classification === 'target-fallback');
  console.error(`\nUnruled examples (${weak.length} total):`);
  for (const e of weak.slice(0, 25)) console.error(`  ${e.name}`);
}

main();
