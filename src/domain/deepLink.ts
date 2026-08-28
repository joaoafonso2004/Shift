/**
 * Normalising an incoming URL to the one form the rest of the app understands.
 *
 * A standalone build owns the `shift://` scheme, so a scanned QR arrives as
 * `shift://squad/A3F9K2` and there is nothing to do. Under Expo Go the app does
 * not own a scheme at all — the same link arrives as
 * `exp://192.168.1.20:8081/--/squad/A3F9K2`, with the development server as the
 * host. A parser that matches on `shift://` therefore works in exactly the
 * build you cannot install without a paid Apple Developer account, and fails in
 * the free one you would use to test the feature.
 *
 * So the scheme is discarded and only the *target* is kept. Everything
 * downstream — `codeFromUrl`, `decodeRoutineLink` — keeps matching one
 * canonical form and stays reachable from the Node test suite.
 */

/** The shape `expo-linking`'s `parse` returns, reduced to what matters here. */
export interface ParsedUrl {
  scheme?: string | null;
  hostname?: string | null;
  path?: string | null;
}

/**
 * What a link can address.
 *
 * A closed list, deliberately. Without it any http URL the OS handed us would
 * be rewritten into a `shift://` one and offered to the parsers, which is a
 * strange thing to do with a link the user may not have meant for this app.
 */
export const LINK_KINDS = ['routine', 'squad'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const OWN_SCHEME = 'shift';

function segments(parsed: ParsedUrl): string[] {
  const parts: string[] = [];

  // On the own scheme the first segment lands in `hostname`: `shift://squad/X`
  // parses to hostname `squad`, path `X`. On a development URL the hostname is
  // the packager's address and the whole target is in the path.
  if (parsed.scheme === OWN_SCHEME && parsed.hostname) parts.push(parsed.hostname);

  const path = (parsed.path ?? '')
    // Expo usually strips its `--/` separator, but not on every platform and
    // not from a hand-typed link.
    .replace(/^\/*(--\/)?/, '');

  for (const segment of path.split('/')) {
    if (segment) parts.push(segment);
  }

  return parts;
}

/**
 * Rewrite any inbound URL as the canonical one, or null if it addresses nothing
 * this app knows how to open.
 */
export function canonicalShiftUrl(parsed: ParsedUrl): string | null {
  const parts = segments(parsed);
  const [kind, ...rest] = parts;

  if (!kind || !(LINK_KINDS as readonly string[]).includes(kind)) return null;
  if (rest.length === 0) return null;

  return `${OWN_SCHEME}://${kind}/${rest.join('/')}`;
}
