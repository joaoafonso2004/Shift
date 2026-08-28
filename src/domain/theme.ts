/**
 * Shift's theme system.
 *
 * Two independent axes: a **surface** (how light or dark the app is) and an
 * **accent** (the one colour that marks the active thing). Keeping them separate
 * is what lets someone run a black OLED app with a mint accent without the
 * design team having to hand-author every combination.
 *
 * Accents carry two values because no single hex reads well on both white and
 * black. Every pairing produced here is checked against WCAG AA by
 * `tests/theme.test.ts` — a theme that looks striking and cannot be read in a
 * bright gym is a bug, not a preference.
 */

export type SurfaceName = 'light' | 'paper' | 'grey' | 'dark' | 'midnight';
export type AccentName = 'blue' | 'amber' | 'mint' | 'violet' | 'coral' | 'cyan';

export interface Surface {
  name: SurfaceName;
  label: string;
  /** True when the surface is dark enough to need light text. */
  isDark: boolean;
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  text: string;
  textDim: string;
  textFaint: string;
}

export interface Accent {
  name: AccentName;
  label: string;
  /** Used on light surfaces. */
  onLight: string;
  /** Used on dark surfaces. */
  onDark: string;
}

export const SURFACES: Record<SurfaceName, Surface> = {
  light: {
    name: 'light',
    label: 'Light',
    isDark: false,
    bg: '#f7f8fa',
    surface: '#ffffff',
    surfaceAlt: '#eef0f4',
    line: '#d9dde4',
    text: '#0d0f14',
    textDim: '#4a5160',
    textFaint: '#6b7380',
  },
  paper: {
    name: 'paper',
    label: 'Paper',
    isDark: false,
    // Warmer and slightly dimmer than Light — easier under gym floodlights.
    bg: '#f4f1ea',
    surface: '#fdfbf6',
    surfaceAlt: '#eae5d9',
    line: '#d6cfbe',
    text: '#1a1712',
    textDim: '#544d3f',
    textFaint: '#6e6656',
  },
  grey: {
    name: 'grey',
    label: 'Grey',
    isDark: true,
    // Mid-grey rather than near-black: less contrast fatigue in a bright room,
    // and the one people ask for when dark feels too harsh.
    bg: '#22262d',
    surface: '#2b3038',
    surfaceAlt: '#343a44',
    line: '#404755',
    text: '#f2f4f7',
    textDim: '#b9c0cc',
    textFaint: '#8a93a2',
  },
  dark: {
    name: 'dark',
    label: 'Dark',
    isDark: true,
    bg: '#08090c',
    surface: '#12141a',
    surfaceAlt: '#1a1d25',
    line: '#272b35',
    text: '#f4f5f7',
    textDim: '#a8b0bd',
    textFaint: '#7d8697',
  },
  midnight: {
    name: 'midnight',
    label: 'Midnight',
    isDark: true,
    // True black. On OLED an unlit pixel draws no power, which matters when the
    // screen stays awake for a whole session.
    bg: '#000000',
    surface: '#0b0b0d',
    surfaceAlt: '#141417',
    line: '#242428',
    text: '#ffffff',
    textDim: '#adadb5',
    textFaint: '#82828c',
  },
};

export const ACCENTS: Record<AccentName, Accent> = {
  blue: { name: 'blue', label: 'Blue', onLight: '#1f5fd0', onDark: '#6fa4ff' },
  amber: { name: 'amber', label: 'Amber', onLight: '#8a5300', onDark: '#ffb340' },
  mint: { name: 'mint', label: 'Mint', onLight: '#0a6f4a', onDark: '#4fe3a8' },
  violet: { name: 'violet', label: 'Violet', onLight: '#6b34c4', onDark: '#c99cff' },
  coral: { name: 'coral', label: 'Coral', onLight: '#a63328', onDark: '#ff8b80' },
  cyan: { name: 'cyan', label: 'Cyan', onLight: '#0a6675', onDark: '#4fd8ea' },
};

export interface ResolvedTheme extends Surface {
  accent: string;
  /** Text colour that reads on top of the accent, for filled buttons. */
  onAccent: string;
  pass: string;
  warn: string;
  fail: string;
  /** Squad identity hues, indexed by color_slot. */
  slots: readonly [string, string, string, string];
}

export function resolveTheme(surfaceName: SurfaceName, accentName: AccentName): ResolvedTheme {
  const surface = SURFACES[surfaceName];
  const accent = ACCENTS[accentName];
  const accentColor = surface.isDark ? accent.onDark : accent.onLight;

  return {
    ...surface,
    accent: accentColor,
    // Filled buttons pick whichever of black or white actually reads on the
    // accent, rather than assuming one or the other.
    onAccent: contrastRatio('#000000', accentColor) >= contrastRatio('#ffffff', accentColor)
      ? '#000000'
      : '#ffffff',
    pass: surface.isDark ? '#4fe3a8' : '#0a6f4a',
    warn: surface.isDark ? '#ffb340' : '#8a5300',
    fail: surface.isDark ? '#ff8b80' : '#a63328',
    slots: surface.isDark
      ? ['#6fa4ff', '#ffb340', '#4fe3a8', '#c99cff']
      : ['#1f5fd0', '#8a5300', '#0a6f4a', '#6b34c4'],
  };
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

export function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA: 4.5:1 for body text, 3:1 for large text and UI boundaries. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

export const SURFACE_NAMES = Object.keys(SURFACES) as SurfaceName[];
export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

/**
 * Theme as CSS custom properties.
 *
 * NativeWind v4 reads these through `vars()`, so switching theme sets variables
 * on one root view rather than re-rendering styled subtrees. Every `className`
 * stays static, which keeps invariant #6 intact.
 */
export function themeVars(theme: ResolvedTheme): Record<string, string> {
  return {
    '--bg': theme.bg,
    '--surface': theme.surface,
    '--surface-alt': theme.surfaceAlt,
    '--line': theme.line,
    '--text': theme.text,
    '--text-dim': theme.textDim,
    '--text-faint': theme.textFaint,
    '--accent': theme.accent,
    '--on-accent': theme.onAccent,
    '--pass': theme.pass,
    '--warn': theme.warn,
    '--fail': theme.fail,
    '--slot-0': theme.slots[0],
    '--slot-1': theme.slots[1],
    '--slot-2': theme.slots[2],
    '--slot-3': theme.slots[3],
  };
}
