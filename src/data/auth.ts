import { getSupabase, isSupabaseConfigured } from './supabase.ts';

/**
 * Identity.
 *
 * Co-op needs identities — a squad is a set of user ids — but a gym app should
 * not demand an email address before someone can log a set. The default is
 * therefore **anonymous sign-in**: the user gets a real Supabase identity with
 * zero friction, their history syncs, and they can join a squad. Upgrading to a
 * permanent account later keeps the same `auth.users` row and therefore all
 * their training data, which is exactly why this is the right default rather
 * than a placeholder.
 *
 * Anonymous sign-in must be enabled in the Supabase dashboard
 * (Authentication → Sign In / Providers → Anonymous). Until it is, every call
 * here fails cleanly and the app stays local-only.
 */

export interface Identity {
  userId: string;
  isAnonymous: boolean;
}

export async function currentIdentity(): Promise<Identity | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { userId: data.user.id, isAnonymous: data.user.is_anonymous ?? false };
}

/**
 * Ensure there is a session, creating an anonymous one if needed.
 *
 * Returns null rather than throwing when Supabase is unconfigured or the
 * provider is disabled — the caller carries on offline. Nothing in the workout
 * flow is allowed to block on this.
 */
export async function ensureIdentity(): Promise<Identity | null> {
  if (!isSupabaseConfigured()) return null;
  const existing = await currentIdentity();
  if (existing) return existing;

  const supabase = getSupabase()!;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) return null;

  // A profile row is what every foreign key in migration 0002 points at.
  await supabase.from('profiles').upsert({ id: data.user.id }, { onConflict: 'id' });

  return { userId: data.user.id, isAnonymous: true };
}

/**
 * Attach an email to an anonymous account.
 *
 * Supabase keeps the same user id, so upgrading never orphans training history.
 * Not wired to any screen yet — it exists so the anonymous default is a
 * deliberate first step rather than a dead end.
 */
export async function upgradeToEmail(email: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: 'not-configured' };

  const { error } = await supabase.auth.updateUser({ email });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  await getSupabase()?.auth.signOut();
}
