import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampIndex,
  COMMIT_DISTANCE,
  COMMIT_VELOCITY,
  resolveSwipe,
  ringWindow,
  slotKey,
} from '../src/domain/swipe.ts';

const WIDTH = 340;
const base = { startIndex: 1, width: WIDTH, count: 5 };

test('a small drag springs back rather than committing', () => {
  assert.equal(resolveSwipe({ ...base, translationX: -40, velocityX: -60 }), 1);
});

test('a slow drag past the distance threshold commits', () => {
  const past = -WIDTH * (COMMIT_DISTANCE + 0.05);
  assert.equal(resolveSwipe({ ...base, translationX: past, velocityX: -50 }), 2);
});

test('a fast flick commits even when barely moved', () => {
  // Distance-only rules ignore this and the gesture feels dead.
  assert.equal(
    resolveSwipe({ ...base, translationX: -30, velocityX: -(COMMIT_VELOCITY + 200) }),
    2,
  );
});

test('a flick backwards while dragging forwards follows the flick', () => {
  // Velocity is the more recent expression of intent.
  const draggedForward = -WIDTH * 0.4;
  assert.equal(
    resolveSwipe({ ...base, translationX: draggedForward, velocityX: COMMIT_VELOCITY + 300 }),
    0,
  );
});

test('a flick can only ever advance one card', () => {
  // Throwing three exercises along would leave the user with no idea what they
  // are looking at.
  assert.equal(resolveSwipe({ ...base, translationX: -2000, velocityX: -9000 }), 2);
});

test('the ends do not wrap around', () => {
  assert.equal(resolveSwipe({ ...base, startIndex: 0, translationX: 400, velocityX: 2000 }), 0);
  assert.equal(resolveSwipe({ ...base, startIndex: 4, translationX: -400, velocityX: -2000 }), 4);
});

test('a single candidate cannot be swiped away', () => {
  assert.equal(
    resolveSwipe({ startIndex: 0, translationX: -900, velocityX: -3000, width: WIDTH, count: 1 }),
    0,
  );
});

test('a zero width does not produce a NaN index', () => {
  const result = resolveSwipe({ ...base, width: 0, translationX: -100, velocityX: -900 });
  assert.equal(Number.isNaN(result), false);
  assert.equal(result, 1);
});

test('clampIndex keeps the ring inside the candidate list', () => {
  assert.equal(clampIndex(-3, 5), 0);
  assert.equal(clampIndex(9, 5), 4);
  assert.equal(clampIndex(2, 0), 0);
});

test('three cards stay mounted wherever the ring sits', () => {
  assert.deepEqual(ringWindow(3, 10), [2, 3, 4]);
  assert.deepEqual(ringWindow(0, 10), [0, 1], 'no phantom card before the first');
  assert.deepEqual(ringWindow(9, 10), [8, 9], 'no phantom card past the last');
  assert.deepEqual(ringWindow(0, 1), [0]);
  assert.deepEqual(ringWindow(0, 0), []);
});

test('slot keys are stable and distinct across the window, so nothing remounts', () => {
  for (let index = 0; index < 20; index++) {
    const keys = ringWindow(index, 20).map(slotKey);
    assert.equal(new Set(keys).size, keys.length, `window at ${index} reused a slot key`);
  }
});

test('advancing the ring reuses the slot the outgoing card vacated', () => {
  // Keying by candidate index would remount on every swap; keying by index % 3
  // means React sees the same three components with new props.
  const before = new Set(ringWindow(4, 10).map(slotKey));
  const after = new Set(ringWindow(5, 10).map(slotKey));
  assert.deepEqual([...before].sort(), [...after].sort());
});
