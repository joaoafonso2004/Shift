import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codeFromUrl,
  formatJoinCode,
  generateJoinCode,
  isValidJoinCode,
  JOIN_ALPHABET,
  JOIN_CODE_LENGTH,
  joinCodeUrl,
  normalizeJoinCode,
} from '../src/domain/joinCode.ts';

test('codes never contain characters that look like other characters', () => {
  // The point of the alphabet: a code read aloud across a gym must not be
  // ambiguous between O/0 or I/1/L.
  for (const banned of ['I', 'L', 'O', 'U']) {
    assert.equal(JOIN_ALPHABET.includes(banned), false, `${banned} must not be generatable`);
  }
  assert.equal(JOIN_ALPHABET.length, 32);
});

test('generated codes are always valid', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    assert.equal(code.length, JOIN_CODE_LENGTH);
    assert.ok(isValidJoinCode(code), `${code} failed validation`);
  }
});

test('generation is deterministic when the random source is', () => {
  const fixed = () => 0;
  assert.equal(generateJoinCode(fixed), '000000');

  let i = 0;
  const stepped = () => (i++ % JOIN_ALPHABET.length) / JOIN_ALPHABET.length;
  assert.equal(generateJoinCode(stepped), '012345');
});

test('a random source returning exactly 1 does not overflow the alphabet', () => {
  const code = generateJoinCode(() => 0.9999999999);
  assert.ok(isValidJoinCode(code), `${code} fell off the end of the alphabet`);
});

test('mistyped letters are repaired to the digits they resemble', () => {
  // O -> 0, I -> 1, L -> 1. Everything else is left alone.
  assert.equal(normalizeJoinCode('OI4L2Z'), '01412Z');
  assert.equal(normalizeJoinCode('o'), '0');
  assert.equal(normalizeJoinCode('l'), '1');
  assert.equal(normalizeJoinCode('U'), 'V');
});

test('separators and case are forgiven', () => {
  assert.equal(normalizeJoinCode('a3f-9k2'), 'A3F9K2');
  assert.equal(normalizeJoinCode('A3F 9K2'), 'A3F9K2');
  assert.equal(normalizeJoinCode('  a3f9k2  '), 'A3F9K2');
});

test('normalization never returns more than a full code', () => {
  assert.equal(normalizeJoinCode('A3F9K2EXTRA').length, JOIN_CODE_LENGTH);
});

test('anything a normalizer produces is either valid or too short', () => {
  for (const input of ['', '!!!', 'abc', 'A3F9K2', 'oil', '------']) {
    const code = normalizeJoinCode(input);
    if (code.length === JOIN_CODE_LENGTH) assert.ok(isValidJoinCode(code));
  }
});

test('validation rejects the wrong length and the excluded letters', () => {
  assert.equal(isValidJoinCode('A3F9K'), false);
  assert.equal(isValidJoinCode('A3F9K22'), false);
  assert.equal(isValidJoinCode('A3F9KO'), false, 'O is not in the alphabet');
  assert.equal(isValidJoinCode(''), false);
});

test('display grouping makes a code readable aloud', () => {
  assert.equal(formatJoinCode('A3F9K2'), 'A3F 9K2');
  assert.equal(formatJoinCode('short'), 'short', 'malformed input passes through');
});

test('a QR round-trips back to the same code', () => {
  const code = generateJoinCode();
  assert.equal(codeFromUrl(joinCodeUrl(code)), code);
});

test('a scanned link is normalized, and rubbish is rejected', () => {
  assert.equal(codeFromUrl('shift://squad/a3f9k2'), 'A3F9K2');
  assert.equal(codeFromUrl('shift://squad/oi4l2z'), '01412Z');
  assert.equal(codeFromUrl('https://evil.example/squad/A3F9K2'), null);
  assert.equal(codeFromUrl('shift://squad/'), null);
  assert.equal(codeFromUrl('not a url'), null);
});
