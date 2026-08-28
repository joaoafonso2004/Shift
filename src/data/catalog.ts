import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import type {
  CatalogExercise,
  CanonicalMuscle,
  LoadType,
  MovementPattern,
  PatternFamily,
  Plane,
  SimilarityReason,
} from '../domain/catalog.ts';
import { toFtsQuery } from '../domain/catalog.ts';
import meta from '../../assets/catalog-meta.json' with { type: 'json' };

/**
 * Read-only access to Shift's prebuilt exercise catalog.
 *
 * The catalog ships as a bundled SQLite file and is copied once into writable
 * storage on first launch. Everything after that is an indexed local read —
 * a Swipe-to-Swap must never wait on the network, and alternatives are queried
 * during card mount so nothing touches the gesture's critical path (§4.4).
 *
 * The copy destination is named for the catalog's build version, so rebuilding
 * the catalog lands at a new path instead of being shadowed by a stale copy
 * left behind by a previous install.
 */

const ASSET = require('../../assets/catalog.db') as number;
const DB_NAME = `catalog-${meta.version}.db`;

let handle: SQLite.SQLiteDatabase | null = null;

export async function openCatalog(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;

  const dir = new Directory(Paths.document, 'SQLite');
  if (!dir.exists) dir.create({ intermediates: true });

  const destination = new File(dir, DB_NAME);
  if (!destination.exists) {
    const asset = Asset.fromModule(ASSET);
    await asset.downloadAsync();
    const source = new File(asset.localUri ?? asset.uri);
    source.copy(destination);
  }

  handle = SQLite.openDatabaseSync(DB_NAME);
  return handle;
}

function db(): SQLite.SQLiteDatabase {
  if (!handle) {
    throw new Error('Catalog not opened. Await openCatalog() before querying.');
  }
  return handle;
}

export function isCatalogOpen(): boolean {
  return handle !== null;
}

export const catalogMeta = meta;

// ---------------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  body_part: string;
  raw_target: string;
  raw_equipment: string;
  target: string;
  secondary: string;
  variant_key: string;
  pattern: string;
  family: string;
  plane: string;
  load_type: string;
  is_compound: number;
  is_unilateral: number;
  stability: number;
  skill: number;
  classification: string;
  image: string | null;
  gif_url: string | null;
  instructions: string | null;
  attribution: string;
}

function toExercise(row: Row): CatalogExercise {
  return {
    id: row.id,
    name: row.name,
    bodyPart: row.body_part,
    rawTarget: row.raw_target,
    rawEquipment: row.raw_equipment,
    target: row.target as CanonicalMuscle,
    secondary: JSON.parse(row.secondary) as CanonicalMuscle[],
    variantKey: row.variant_key,
    pattern: row.pattern as MovementPattern,
    family: row.family as PatternFamily,
    plane: row.plane as Plane,
    loadType: row.load_type as LoadType,
    isCompound: row.is_compound === 1,
    isUnilateral: row.is_unilateral === 1,
    stability: row.stability as 0 | 1 | 2,
    skill: row.skill as 0 | 1 | 2,
    classification: row.classification as CatalogExercise['classification'],
    image: row.image,
    gifUrl: row.gif_url,
    instructions: row.instructions,
    attribution: row.attribution,
  };
}

const SELECT = 'select * from exercises';

export function getExercise(id: string): CatalogExercise | null {
  const row = db().getFirstSync<Row>(`${SELECT} where id = ?`, [id]);
  return row ? toExercise(row) : null;
}

export function getExercises(ids: readonly string[]): CatalogExercise[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db().getAllSync<Row>(`${SELECT} where id in (${placeholders})`, [...ids]);
  // Preserve caller order; `in` does not guarantee it.
  const byId = new Map(rows.map((r) => [r.id, toExercise(r)]));
  return ids.map((id) => byId.get(id)).filter((e): e is CatalogExercise => e !== undefined);
}

export interface AlternativeRow {
  exercise: CatalogExercise;
  score: number;
  reason: SimilarityReason;
}

/**
 * Precomputed alternatives, in presentation order.
 *
 * Ordered by `rank`, never by `score`: rank is the selection order produced by
 * the diversity pass at build time, so rank 3 can legitimately score below
 * rank 4. Sorting by score here would undo the diversification and hand the
 * user twelve variations of the same movement (§5.3).
 */
export function getAlternatives(id: string, limit = 12): AlternativeRow[] {
  const rows = db().getAllSync<Row & { score: number; reason: string }>(
    `select e.*, s.score, s.reason
       from exercise_similarity s
       join exercises e on e.id = s.alt_id
      where s.exercise_id = ?
      order by s.rank
      limit ?`,
    [id, limit],
  );
  return rows.map((row) => ({
    exercise: toExercise(row),
    score: row.score,
    reason: JSON.parse(row.reason) as SimilarityReason,
  }));
}

export function searchExercises(query: string, limit = 40): CatalogExercise[] {
  const match = toFtsQuery(query);
  if (match === null) return [];
  const rows = db().getAllSync<Row>(
    `select e.* from exercises_fts f
       join exercises e on e.id = f.id
      where exercises_fts match ?
      order by rank
      limit ?`,
    [match, limit],
  );
  return rows.map(toExercise);
}

export function listByPattern(pattern: MovementPattern, limit = 60): CatalogExercise[] {
  const rows = db().getAllSync<Row>(`${SELECT} where pattern = ? order by name limit ?`, [
    pattern,
    limit,
  ]);
  return rows.map(toExercise);
}
