import type { CanonicalMuscle, CatalogExercise, MovementPattern } from '../../src/domain/catalog.ts';
import { canonicalEquipment } from './equipment.ts';
import { canonicalMuscle } from './muscles.ts';
import {
  classifyPattern,
  isCompound,
  isUnilateral,
  PATTERN_FAMILY,
  PATTERN_PLANE,
  skillFor,
} from './patterns.ts';

export interface RawExercise {
  id: string;
  name: string;
  category: string;
  body_part: string;
  equipment: string;
  instructions: Record<string, string>;
  instruction_steps: Record<string, string[]>;
  muscle_group: string;
  secondary_muscles: string[];
  target: string;
  image: string;
  gif_url: string;
  media_id: string;
  created_at: string;
  attribution: string;
}

/** Hand corrections, applied after classification and marked as `override`. */
export interface Override {
  pattern?: MovementPattern;
  isUnilateral?: boolean;
  skill?: 0 | 1 | 2;
  note?: string;
}

/**
 * Strip media-variant markers so the same movement collapses to one key.
 *
 * The dataset renders some exercises several times — different camera angle,
 * different model, a numbered revision. "barbell full squat" and "barbell full
 * squat (back pov)" are one exercise with two GIFs.
 */
export function variantKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((?:back|side|front|top)?\s*pov\)/g, '')
    .replace(/\((?:male|female)\)/g, '')
    .replace(/\bv\.?\s*\d+\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface NormalizeResult {
  exercises: CatalogExercise[];
  errors: string[];
  stats: {
    total: number;
    byClassification: Record<string, number>;
    unmappedMuscles: Map<string, number>;
    unmappedEquipment: Map<string, number>;
  };
}

export function normalizeAll(
  rows: readonly RawExercise[],
  overrides: Record<string, Override> = {},
  locale = 'en',
): NormalizeResult {
  const exercises: CatalogExercise[] = [];
  const errors: string[] = [];
  const byClassification: Record<string, number> = {};
  const unmappedMuscles = new Map<string, number>();
  const unmappedEquipment = new Map<string, number>();

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of rows) {
    const target = canonicalMuscle(row.target);
    if (target === null) {
      bump(unmappedMuscles, row.target);
      errors.push(`${row.id} "${row.name}": unmapped target "${row.target}"`);
      continue;
    }

    const equipment = canonicalEquipment(row.equipment);
    if (equipment === null) {
      bump(unmappedEquipment, row.equipment);
      errors.push(`${row.id} "${row.name}": unmapped equipment "${row.equipment}"`);
      continue;
    }

    // `muscle_group` is the primary synergist, not a broader grouping of
    // `target` — the dataset's own sit-up record has target "abs" and
    // muscle_group "hip flexors". Folding it into the secondary set is the
    // treatment that makes the Jaccard term meaningful.
    const secondarySet = new Set<CanonicalMuscle>();
    for (const raw of [row.muscle_group, ...(row.secondary_muscles ?? [])]) {
      if (!raw) continue;
      const canon = canonicalMuscle(raw);
      if (canon === null) {
        bump(unmappedMuscles, raw);
        errors.push(`${row.id} "${row.name}": unmapped secondary muscle "${raw}"`);
        continue;
      }
      if (canon !== target) secondarySet.add(canon);
    }
    const secondary = [...secondarySet].sort();

    const override = overrides[row.id];
    const classified = classifyPattern({
      name: row.name,
      target,
      bodyPart: row.body_part,
    });
    const pattern = override?.pattern ?? classified.pattern;
    const source = override?.pattern ? 'override' : classified.source;
    byClassification[source] = (byClassification[source] ?? 0) + 1;

    exercises.push({
      id: row.id,
      name: row.name,
      bodyPart: row.body_part,
      rawTarget: row.target,
      rawEquipment: row.equipment,
      target,
      secondary,
      variantKey: variantKey(row.name),
      pattern,
      family: PATTERN_FAMILY[pattern],
      plane: PATTERN_PLANE[pattern],
      loadType: equipment.loadType,
      isCompound: isCompound(pattern, secondary.length),
      isUnilateral: override?.isUnilateral ?? isUnilateral(row.name),
      stability: equipment.stability,
      skill: override?.skill ?? skillFor(pattern, equipment.skill),
      classification: source,
      image: row.image ?? null,
      gifUrl: row.gif_url ?? null,
      // Nine of the ten shipped languages are dropped here. Instructions are the
      // bulk of the 16.6 MB source; additional locales ship as download packs.
      instructions: row.instructions?.[locale] ?? null,
      attribution: row.attribution,
    });
  }

  return {
    exercises,
    errors,
    stats: {
      total: rows.length,
      byClassification,
      unmappedMuscles,
      unmappedEquipment,
    },
  };
}
