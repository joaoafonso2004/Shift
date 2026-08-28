/**
 * Join codes for a Sync Session.
 *
 * Someone reads this aloud across a noisy gym, or squints at it on a phone held
 * at arm's length. Everything here exists to survive that.
 */

/**
 * Crockford-style alphabet: `I`, `L`, `O` and `U` are excluded.
 *
 * Excluding the *letters* rather than the digits is the useful direction. If `O`
 * can never appear in a code, then a character that looks like one can only be a
 * zero — so a mistyped `O` is unambiguously recoverable, which it would not be
 * if both were valid. `U` is dropped separately, to keep codes from
 * accidentally spelling something unfortunate.
 */
export const JOIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const JOIN_CODE_LENGTH = 6;

/** 32^6 — a billion codes, against at most a few thousand live at once. */
export const JOIN_CODE_SPACE = JOIN_ALPHABET.length ** JOIN_CODE_LENGTH;

/**
 * Repair what someone actually typed.
 *
 * Separators are stripped so `A3F-9K2` and `a3f 9k2` both work, and the four
 * excluded letters map onto the digits they resemble.
 */
export function normalizeJoinCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
    .slice(0, JOIN_CODE_LENGTH);
}

export function isValidJoinCode(code: string): boolean {
  if (code.length !== JOIN_CODE_LENGTH) return false;
  for (const char of code) {
    if (!JOIN_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Generate a code.
 *
 * `random` is injected so generation is deterministic under test. Production
 * passes a crypto-backed source; predictable codes would let anyone walk into
 * someone else's session.
 */
export function generateJoinCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    const index = Math.floor(random() * JOIN_ALPHABET.length) % JOIN_ALPHABET.length;
    out += JOIN_ALPHABET[index];
  }
  return out;
}

/** Grouped for display: `A3F 9K2` reads aloud far better than `A3F9K2`. */
export function formatJoinCode(code: string): string {
  if (code.length !== JOIN_CODE_LENGTH) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** Deep link a QR code encodes, so scanning skips typing entirely. */
export function joinCodeUrl(code: string): string {
  return `shift://squad/${code}`;
}

export function codeFromUrl(url: string): string | null {
  const match = /^shift:\/\/squad\/([0-9A-Za-z]+)$/.exec(url.trim());
  if (!match) return null;
  const code = normalizeJoinCode(match[1]!);
  return isValidJoinCode(code) ? code : null;
}
