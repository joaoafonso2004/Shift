import { Appearance } from 'react-native';
import { create } from 'zustand';

import {
  applyUnitSystem,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Settings,
  type UnitSystem,
} from '../domain/settings.ts';
import { resolveTheme, type ResolvedTheme, type SurfaceName } from '../domain/theme.ts';
import { openLocalDb } from '../data/localDb.ts';
import { setReduceMotion } from '../motion/springs.ts';

/**
 * Settings, persisted to the device-local database.
 *
 * Stored as one JSON row rather than a column per field: settings change shape
 * far more often than they are read, and `normalizeSettings` repairs whatever
 * comes back — so adding a field never needs a migration.
 */

const TABLE = `
create table if not exists settings (
  id integer primary key check (id = 1),
  json text not null
);`;

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => void;
  update: (patch: Partial<Settings>) => void;
  setUnitSystem: (unitSystem: UnitSystem) => void;
  reset: () => void;
}

/** Push settings into the places that are not React state. */
function applySideEffects(settings: Settings): void {
  setReduceMotion(settings.reduceMotion);
}

function persist(settings: Settings): void {
  try {
    const db = openLocalDb();
    db.exec(TABLE);
    db.run('insert into settings (id, json) values (1, ?) on conflict (id) do update set json = excluded.json', [
      JSON.stringify(settings),
    ]);
  } catch {
    // A failed write must never break the app. The user keeps their choice for
    // this session and it is retried on the next change.
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: () => {
    try {
      const db = openLocalDb();
      db.exec(TABLE);
      const row = db.get<{ json: string }>('select json from settings where id = 1');
      const settings = normalizeSettings(row ? (JSON.parse(row.json) as Partial<Settings>) : null);
      applySideEffects(settings);
      set({ settings, loaded: true });
    } catch {
      set({ settings: DEFAULT_SETTINGS, loaded: true });
    }
  },

  update: (patch) => {
    const settings = normalizeSettings({ ...get().settings, ...patch });
    applySideEffects(settings);
    set({ settings });
    persist(settings);
  },

  // Not a plain field write: changing units swaps the bar and the plate
  // inventory, because a US gym genuinely has different equipment.
  setUnitSystem: (unitSystem) => {
    const settings = normalizeSettings(applyUnitSystem(get().settings, unitSystem));
    set({ settings });
    persist(settings);
  },

  reset: () => {
    set({ settings: DEFAULT_SETTINGS });
    persist(DEFAULT_SETTINGS);
  },
}));

/** Resolve the surface preference against the OS when it is set to follow. */
export function useTheme(): ResolvedTheme {
  const settings = useSettings((s) => s.settings);
  const surface: SurfaceName =
    settings.surface === 'system'
      ? Appearance.getColorScheme() === 'light'
        ? 'light'
        : 'dark'
      : settings.surface;
  return resolveTheme(surface, settings.accent);
}
