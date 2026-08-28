/**
 * All internal mass arithmetic runs in integer centi-kilograms (1 kg = 100 cKg).
 *
 * Plate math is full of values like 1.25 and 2.5 that do not survive binary
 * floating point cleanly. Comparing `62.5 === 20 + 2 * 21.25` is the kind of
 * thing that produces a bar the app insists is loaded wrong. Quantising to
 * integers once, at the boundary, removes the entire class of bug.
 */

export type CKg = number;

export function toCKg(kg: number): CKg {
  return Math.round(kg * 100);
}

export function toKg(c: CKg): number {
  return c / 100;
}

/** Sum a list of kg values without accumulating float error. */
export function sumKg(values: readonly number[]): number {
  let acc = 0;
  for (const v of values) acc += toCKg(v);
  return toKg(acc);
}
