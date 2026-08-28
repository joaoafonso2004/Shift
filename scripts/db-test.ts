import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Run `supabase/tests/rls.sql` against the local Supabase stack.
 *
 * The assertions live in SQL rather than in TypeScript because what is being
 * tested *is* SQL: a policy is only meaningful as evaluated by Postgres, for a
 * given role, with a given `auth.uid()`. Any harness that reimplemented that in
 * JavaScript would be testing the harness.
 *
 * psql is reached through the database container rather than a local install —
 * `supabase start` already put one there, and requiring a second Postgres on the
 * developer's machine to test the first would be a strange thing to ask.
 */

const PROJECT = 'shift';
const CONTAINER = `supabase_db_${PROJECT}`;
const SCRIPT = 'supabase/tests/rls.sql';

function containerIsUp(): boolean {
  try {
    const out = execFileSync('docker', ['ps', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}'], {
      encoding: 'utf8',
    });
    return out.trim() === CONTAINER;
  } catch {
    return false;
  }
}

if (!containerIsUp()) {
  console.error(`\n  ${CONTAINER} is not running.\n`);
  console.error('  Start the local stack first:\n');
  console.error('    npx supabase start\n');
  process.exit(1);
}

const sql = readFileSync(SCRIPT, 'utf8');

// ON_ERROR_STOP turns a failed assertion into a non-zero exit, which is the
// only reason this is usable from `npm run verify`.
const result = spawnSync(
  'docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
  { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
// psql writes `raise notice` to stderr, so the passing lines and the failing
// ones arrive on the same stream. Print everything and let the exit code decide.
process.stdout.write(output.replace(/^NOTICE:\s+/gm, '  '));

if (result.status !== 0) {
  console.error(`\n  ${SCRIPT} failed.\n`);
  process.exit(1);
}
