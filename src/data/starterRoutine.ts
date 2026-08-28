/**
 * Catalog ids for the built-in starter routine, verified against
 * assets/catalog.db.
 *
 * This is the only thing that survived `seedHistory.ts`. History now comes from
 * the device-local database — real logged sets, written by the user — so a first
 * run genuinely cold-starts every exercise and the predictions sharpen as the
 * user trains.
 *
 * It lives alone in its own module, with no imports at all, because
 * `src/data/routines.ts` reaches expo-crypto and the Node test suite cannot
 * follow it there. One constant is not worth making a test file unreachable
 * (invariant 19).
 */
export const STARTER_ROUTINE: readonly string[] = [
  '0043', // barbell full squat
  '0025', // barbell bench press
  '2330', // cable lat pulldown full range of motion
  '0405', // dumbbell seated shoulder press
];
