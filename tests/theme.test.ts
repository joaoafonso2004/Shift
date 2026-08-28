import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AA_LARGE,
  AA_TEXT,
  ACCENT_NAMES,
  ACCENTS,
  contrastRatio,
  relativeLuminance,
  resolveTheme,
  SURFACE_NAMES,
  SURFACES,
  themeVars,
} from '../src/domain/theme.ts';

test('luminance and contrast match the WCAG reference values', () => {
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000') * 100) / 100, 21);
  assert.equal(contrastRatio('#4f8cff', '#4f8cff'), 1, 'a colour against itself');
});

test('shorthand hex parses the same as longhand', () => {
  assert.equal(relativeLuminance('#fff'), relativeLuminance('#ffffff'));
});

/**
 * The point of the whole exercise: a theme that looks striking and cannot be
 * read in a bright gym is a bug. These run over every combination rather than
 * spot-checking, because the failures are always in the pairing nobody tried.
 */
test('body text is readable on every surface', () => {
  for (const name of SURFACE_NAMES) {
    const s = SURFACES[name];
    const ratio = contrastRatio(s.text, s.bg);
    assert.ok(ratio >= AA_TEXT, `${name}: text on bg is ${ratio.toFixed(2)}:1`);

    const onSurface = contrastRatio(s.text, s.surface);
    assert.ok(onSurface >= AA_TEXT, `${name}: text on surface is ${onSurface.toFixed(2)}:1`);
  }
});

test('secondary text stays readable, not just decorative', () => {
  for (const name of SURFACE_NAMES) {
    const s = SURFACES[name];
    const dim = contrastRatio(s.textDim, s.surface);
    assert.ok(dim >= AA_TEXT, `${name}: dim text is ${dim.toFixed(2)}:1`);
  }
});

test('faint text clears the large-text threshold at minimum', () => {
  // Faint is used for labels and captions at small sizes, so AA_LARGE is the
  // floor it must not drop below.
  for (const name of SURFACE_NAMES) {
    const s = SURFACES[name];
    const faint = contrastRatio(s.textFaint, s.surface);
    assert.ok(faint >= AA_LARGE, `${name}: faint text is ${faint.toFixed(2)}:1`);
  }
});

test('every accent is readable on every surface it can appear on', () => {
  // 5 surfaces x 6 accents = 30 pairings. Authoring these by eye is exactly how
  // one unreadable combination ships.
  for (const surfaceName of SURFACE_NAMES) {
    for (const accentName of ACCENT_NAMES) {
      const theme = resolveTheme(surfaceName, accentName);
      const ratio = contrastRatio(theme.accent, theme.bg);
      assert.ok(
        ratio >= AA_LARGE,
        `${surfaceName} + ${accentName}: accent on bg is ${ratio.toFixed(2)}:1`,
      );

      const onSurface = contrastRatio(theme.accent, theme.surface);
      assert.ok(
        onSurface >= AA_LARGE,
        `${surfaceName} + ${accentName}: accent on surface is ${onSurface.toFixed(2)}:1`,
      );
    }
  }
});

test('filled buttons pick a label colour that actually reads', () => {
  for (const surfaceName of SURFACE_NAMES) {
    for (const accentName of ACCENT_NAMES) {
      const theme = resolveTheme(surfaceName, accentName);
      const ratio = contrastRatio(theme.onAccent, theme.accent);
      assert.ok(
        ratio >= AA_LARGE,
        `${surfaceName} + ${accentName}: label on accent is ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

test('status colours are distinguishable from the surface', () => {
  for (const surfaceName of SURFACE_NAMES) {
    const theme = resolveTheme(surfaceName, 'blue');
    for (const [label, colour] of [
      ['pass', theme.pass],
      ['warn', theme.warn],
      ['fail', theme.fail],
    ] as const) {
      const ratio = contrastRatio(colour, theme.surface);
      assert.ok(ratio >= AA_LARGE, `${surfaceName}: ${label} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('the four squad slot colours are distinguishable from each other', () => {
  // Squad identity is carried by hue alone at the ambient level, so two members
  // must never be the same colour.
  for (const surfaceName of SURFACE_NAMES) {
    const { slots } = resolveTheme(surfaceName, 'blue');
    assert.equal(new Set(slots).size, 4, `${surfaceName}: duplicate slot colours`);

    for (const slot of slots) {
      const ratio = contrastRatio(slot, resolveTheme(surfaceName, 'blue').surface);
      assert.ok(ratio >= AA_LARGE, `${surfaceName}: slot ${slot} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('accents carry separate values for light and dark, and they differ', () => {
  for (const name of ACCENT_NAMES) {
    const accent = ACCENTS[name];
    assert.notEqual(accent.onLight, accent.onDark, `${name} reuses one hex for both`);
    assert.ok(
      relativeLuminance(accent.onDark) > relativeLuminance(accent.onLight),
      `${name}: the dark-surface variant should be the lighter one`,
    );
  }
});

test('surfaces declare their darkness honestly', () => {
  for (const name of SURFACE_NAMES) {
    const s = SURFACES[name];
    const bgIsDark = relativeLuminance(s.bg) < 0.2;
    assert.equal(s.isDark, bgIsDark, `${name}: isDark does not match its background`);
  }
});

test('every theme emits a complete variable set', () => {
  for (const surfaceName of SURFACE_NAMES) {
    for (const accentName of ACCENT_NAMES) {
      const vars = themeVars(resolveTheme(surfaceName, accentName));
      for (const key of ['--bg', '--surface', '--text', '--accent', '--on-accent', '--slot-3']) {
        assert.match(vars[key] ?? '', /^#[0-9a-f]{6}$/i, `${surfaceName}/${accentName} ${key}`);
      }
    }
  }
});
