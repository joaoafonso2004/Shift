import * as SQLite from 'expo-sqlite';

import { initLocalDb, type SqlDb } from './localSchema.ts';

/**
 * The device-local database, adapted to the `SqlDb` interface the repository
 * speaks.
 *
 * Kept behind the same interface the tests use, so the queries that run here are
 * literally the ones verified in `tests/repository.test.ts` — no second
 * implementation to drift.
 */

const DB_NAME = 'shift-local.db';

let handle: SQLite.SQLiteDatabase | null = null;
let adapter: SqlDb | null = null;

function adapt(db: SQLite.SQLiteDatabase): SqlDb {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params = []) => {
      db.runSync(sql, params as SQLite.SQLiteBindValue[]);
    },
    all: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.getAllSync(sql, params as SQLite.SQLiteBindValue[]) as T[],
    get: <T,>(sql: string, params: readonly unknown[] = []) =>
      (db.getFirstSync(sql, params as SQLite.SQLiteBindValue[]) as T) ?? null,
  };
}

export function openLocalDb(): SqlDb {
  if (adapter) return adapter;
  handle = SQLite.openDatabaseSync(DB_NAME);
  adapter = adapt(handle);
  initLocalDb(adapter);
  return adapter;
}

export function isLocalDbOpen(): boolean {
  return adapter !== null;
}

/** Test and development helper. Never called from the app. */
export function resetLocalDb(): void {
  handle?.closeSync();
  handle = null;
  adapter = null;
  SQLite.deleteDatabaseSync(DB_NAME);
}
