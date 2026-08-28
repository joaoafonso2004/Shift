import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalShiftUrl } from '../src/domain/deepLink.ts';
import { codeFromUrl } from '../src/domain/joinCode.ts';
import { decodeRoutineLink, encodeRoutineLink, SHARE_VERSION } from '../src/domain/sharing.ts';

/**
 * The inputs are what `expo-linking`'s `parse` produces for each case. They are
 * written out rather than generated so the difference between a standalone
 * build and Expo Go is visible in the test itself.
 */

test('a link on our own scheme survives unchanged', () => {
  assert.equal(
    canonicalShiftUrl({ scheme: 'shift', hostname: 'squad', path: 'A3F9K2' }),
    'shift://squad/A3F9K2',
  );
});

test('the same link arriving through Expo Go reaches the same place', () => {
  // exp://192.168.1.20:8081/--/squad/A3F9K2
  assert.equal(
    canonicalShiftUrl({ scheme: 'exp', hostname: '192.168.1.20', path: 'squad/A3F9K2' }),
    'shift://squad/A3F9K2',
  );
});

test('the development separator is stripped when the platform leaves it in', () => {
  assert.equal(
    canonicalShiftUrl({ scheme: 'exp', hostname: '127.0.0.1', path: '--/squad/A3F9K2' }),
    'shift://squad/A3F9K2',
  );
});

test('leading slashes do not produce an empty first segment', () => {
  assert.equal(
    canonicalShiftUrl({ scheme: 'exp', hostname: '127.0.0.1', path: '/squad/A3F9K2' }),
    'shift://squad/A3F9K2',
  );
});

test('a link addressing nothing we own is refused rather than rewritten', () => {
  // Otherwise any URL the OS handed us would be turned into a shift:// one and
  // offered to the parsers.
  for (const parsed of [
    { scheme: 'https', hostname: 'example.com', path: 'pricing' },
    { scheme: 'shift', hostname: 'settings', path: 'theme' },
    { scheme: 'exp', hostname: '127.0.0.1', path: '' },
    { scheme: 'shift', hostname: 'squad', path: '' },
    {},
  ]) {
    assert.equal(canonicalShiftUrl(parsed), null, `accepted ${JSON.stringify(parsed)}`);
  }
});

test('a routine payload passes through intact, base64url characters included', () => {
  const routine = decodeRoutineLink(
    canonicalShiftUrl({
      scheme: 'exp',
      hostname: '192.168.1.20',
      path: `routine/${encodeRoutineLink({
        version: SHARE_VERSION,
        title: 'Pernas',
        note: null,
        fromHandle: null,
        createdAt: '2026-08-28T09:00:00.000Z',
        exercises: [{ exerciseId: '0043', name: '', sets: 3, reps: 5 }],
      }).replace('shift://routine/', '')}`,
    })!,
  );

  assert.notEqual(routine, null);
  assert.equal(routine!.title, 'Pernas');
  assert.equal(routine!.exercises[0]!.exerciseId, '0043');
});

test('a squad code still reads back through the existing parser', () => {
  const url = canonicalShiftUrl({ scheme: 'exp', hostname: '10.0.0.4', path: 'squad/a3f9k2' })!;
  assert.equal(codeFromUrl(url), 'A3F9K2');
});
