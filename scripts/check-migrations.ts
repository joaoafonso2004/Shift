/**
 * Parse every migration with the real PostgreSQL grammar.
 *
 *   node scripts/check-migrations.ts
 *
 * Uses libpg_query compiled to WebAssembly — the same parser the server uses, so
 * a file that passes here will at least reach the planner. It validates syntax,
 * not semantics: a typo in a column name still gets through, but `create tabel`
 * does not, and neither does an unbalanced dollar-quoted function body.
 *
 * Runs on any OS with no database and no Docker, which is why it is in
 * `npm run verify` rather than being something to remember before pushing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const DIR = 'supabase/migrations';

interface ParseResult {
  error?: { message: string; cursorpos?: number } | null;
  parse_tree?: { stmts?: unknown[] };
}

/** Line number for a byte offset, so an error points at somewhere real. */
function lineOf(sql: string, cursor: number): number {
  return sql.slice(0, Math.max(0, cursor)).split('\n').length;
}

type PgFactory = () => Promise<{ parse: (sql: string) => ParseResult }>;

/**
 * The package is CommonJS and its shape differs between `require` and ESM
 * default-import interop, so resolve it explicitly rather than guessing.
 */
function loadParser(): PgFactory {
  const req = createRequire(import.meta.url);
  const mod = req('pg-query-emscripten') as PgFactory | { default: PgFactory };
  return typeof mod === 'function' ? mod : mod.default;
}

async function main(): Promise<void> {
  const pg = await loadParser()();

  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error(`No migrations found in ${DIR}`);
    process.exit(1);
  }

  let failed = 0;
  let statements = 0;

  for (const file of files) {
    const sql = readFileSync(join(DIR, file), 'utf8');
    const result = pg.parse(sql);

    if (result.error) {
      failed++;
      const line = result.error.cursorpos ? lineOf(sql, result.error.cursorpos) : 0;
      console.error(`  FAIL ${file}${line ? `:${line}` : ''} — ${result.error.message}`);
      continue;
    }

    const count = result.parse_tree?.stmts?.length ?? 0;
    statements += count;
    console.log(`  ok   ${file}  (${count} statements)`);
  }

  console.log(
    `\n${files.length - failed}/${files.length} migrations parse, ${statements} statements total.`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
