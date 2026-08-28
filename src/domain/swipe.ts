/**
 * Swipe resolution for the Swipe-to-Swap card ring.
 *
 * Pure and worklet-safe so the same function decides the outcome on the UI
 * thread and can be tested in Node. Position is expressed in **card units**
 * rather than pixels: 2.0 means "the third candidate is centred", 2.4 means the
 * finger has dragged 40% of a card toward the fourth. One continuous value
 * carries both the drag and the settled state, which is what removes the
 * one-frame flash a separate reset would cause.
 */

/** Fraction of a card width past which a slow drag still commits. */
export const COMMIT_DISTANCE = 0.28;
/** Pixels per second past which a flick commits regardless of distance. */
export const COMMIT_VELOCITY = 550;

export function clampIndex(index: number, count: number): number {
  'worklet';
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Where the ring should settle when the finger lifts.
 *
 * Distance and velocity are both consulted because either alone feels wrong: a
 * distance-only rule ignores a fast flick that barely moved, and a
 * velocity-only rule ignores a slow deliberate drag most of the way across.
 * A flick can only ever advance one card — throwing the ring three exercises
 * along would leave the user with no idea what they are looking at.
 */
export function resolveSwipe(input: {
  startIndex: number;
  /** Horizontal travel in pixels. Negative drags toward the next candidate. */
  translationX: number;
  velocityX: number;
  width: number;
  count: number;
}): number {
  'worklet';
  const { startIndex, translationX, velocityX, width, count } = input;
  if (count <= 1 || width <= 0) return clampIndex(startIndex, count);

  const travelled = -translationX / width;
  const flicked = Math.abs(velocityX) > COMMIT_VELOCITY;
  const dragged = Math.abs(travelled) > COMMIT_DISTANCE;

  if (!flicked && !dragged) return clampIndex(startIndex, count);

  // A flick and a drag can disagree — a fast flick back while dragging forward.
  // Velocity wins, because it is the more recent expression of intent.
  const direction = flicked ? (velocityX < 0 ? 1 : -1) : travelled > 0 ? 1 : -1;
  return clampIndex(startIndex + direction, count);
}

/**
 * Candidate indices the ring should keep mounted around `index`.
 *
 * Always three where the list allows it, so the card either side of the current
 * one is already laid out and measured before any finger lands on it. Mount
 * cost inside a gesture is unrecoverable — it arrives exactly where the user is
 * looking.
 */
export function ringWindow(index: number, count: number): number[] {
  'worklet';
  if (count <= 0) return [];
  const out: number[] = [];
  for (let i = index - 1; i <= index + 1; i++) {
    if (i >= 0 && i < count) out.push(i);
  }
  return out;
}

/**
 * Stable slot key for a candidate index.
 *
 * Keying by `index % 3` means advancing the ring changes each slot's *props*
 * rather than its identity, so React reconciles three long-lived components
 * instead of unmounting one card and mounting another. Keying by the candidate
 * index itself would remount on every swap — the exact layout thrash the ring
 * exists to avoid.
 */
export function slotKey(candidateIndex: number): number {
  'worklet';
  return ((candidateIndex % 3) + 3) % 3;
}
