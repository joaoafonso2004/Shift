/**
 * Fetch the raw exercise dataset.
 *
 *   node scripts/fetch-dataset.ts [--force]
 *
 * The raw file is ~16.6 MB and is not committed — only the derived catalog is.
 * Pinned to a commit rather than a branch so a build is reproducible: the
 * classification rules and the muscle map are audited against a specific
 * snapshot, and silently tracking `main` would let upstream edits change swap
 * suggestions with no diff to review.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const REF = 'main'; // TODO: pin to a commit SHA once the map is audited against one
const URL = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${REF}/data/exercises.json`;
const OUT = 'data/raw/exercises.json';

async function main(): Promise<void> {
  if (existsSync(OUT) && !process.argv.includes('--force')) {
    console.log(`${OUT} already present. Use --force to re-download.`);
    return;
  }

  console.log(`Fetching ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const text = await res.text();
  const parsed = JSON.parse(text) as unknown[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('Unexpected payload: expected a non-empty array of exercises.');
    process.exit(1);
  }

  mkdirSync('data/raw', { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`Wrote ${OUT} — ${parsed.length} exercises, ${(text.length / 1024 / 1024).toFixed(1)} MB`);
}

main();
