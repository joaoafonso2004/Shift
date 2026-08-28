import * as Crypto from 'expo-crypto';

import {
  generateJoinCode,
  isValidJoinCode,
  JOIN_ALPHABET,
  normalizeJoinCode,
} from '../domain/joinCode.ts';
import { ensureIdentity } from './auth.ts';
import { getSupabase } from './supabase.ts';

/**
 * Creating and joining a Sync Session.
 *
 * Codes are short and short-lived: a session expires after six hours, so the
 * space only ever has to be unique among the handful of sessions live at once
 * rather than across all history. That is what allows six characters instead of
 * a UUID nobody could read aloud.
 */

export interface SessionSummary {
  id: string;
  joinCode: string;
  hostUserId: string;
  memberCount: number;
  maxMembers: number;
  colorSlot: 0 | 1 | 2 | 3;
}

export type SessionResult =
  | { ok: true; session: SessionSummary }
  | { ok: false; reason: 'not-configured' | 'no-identity' | 'not-found' | 'full' | 'expired' | 'error'; message?: string };

/** Crypto-backed, because a predictable code lets anyone walk into a session. */
function secureRandom(): number {
  const bytes = Crypto.getRandomBytes(4);
  const value =
    ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  return value / 0x1_0000_0000;
}

const MAX_CODE_ATTEMPTS = 5;

export async function createSession(): Promise<SessionResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: 'not-configured' };

  const identity = await ensureIdentity();
  if (!identity) return { ok: false, reason: 'no-identity' };

  // Collisions are vanishingly rare but not impossible, and the unique index is
  // the only thing that actually decides. Retry on rejection rather than
  // pre-checking, which would race.
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const joinCode = generateJoinCode(secureRandom);

    const { data, error } = await supabase
      .from('sync_sessions')
      .insert({ host_user_id: identity.userId, join_code: joinCode })
      .select('id, join_code, host_user_id, max_members')
      .single();

    if (error) {
      if (error.code === '23505') continue; // unique violation: try another code
      return { ok: false, reason: 'error', message: error.message };
    }

    const joined = await addMember(data.id, identity.userId, 0);
    if (!joined.ok) return joined;

    return {
      ok: true,
      session: {
        id: data.id,
        joinCode: data.join_code,
        hostUserId: data.host_user_id,
        memberCount: 1,
        maxMembers: data.max_members,
        colorSlot: 0,
      },
    };
  }

  return { ok: false, reason: 'error', message: 'could not allocate a join code' };
}

export async function joinByCode(input: string): Promise<SessionResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: 'not-configured' };

  const code = normalizeJoinCode(input);
  if (!isValidJoinCode(code)) return { ok: false, reason: 'not-found' };

  const identity = await ensureIdentity();
  if (!identity) return { ok: false, reason: 'no-identity' };

  const { data: session, error } = await supabase
    .from('sync_sessions')
    .select('id, join_code, host_user_id, max_members, expires_at, status')
    .eq('join_code', code)
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: error.message };
  if (!session) return { ok: false, reason: 'not-found' };
  if (Date.parse(session.expires_at) < Date.now() || session.status === 'ended') {
    return { ok: false, reason: 'expired' };
  }

  const { data: members, error: membersError } = await supabase
    .from('sync_members')
    .select('user_id, color_slot')
    .eq('session_id', session.id);

  if (membersError) return { ok: false, reason: 'error', message: membersError.message };

  const existing = members?.find((m) => m.user_id === identity.userId);
  if (existing) {
    return {
      ok: true,
      session: {
        id: session.id,
        joinCode: session.join_code,
        hostUserId: session.host_user_id,
        memberCount: members!.length,
        maxMembers: session.max_members,
        colorSlot: existing.color_slot as 0 | 1 | 2 | 3,
      },
    };
  }

  if ((members?.length ?? 0) >= session.max_members) return { ok: false, reason: 'full' };

  // Slots are reused, not incremented: someone leaving frees their colour for
  // the next joiner, and the four preallocated shared-value slots stay dense.
  const taken = new Set((members ?? []).map((m) => m.color_slot));
  const slot = [0, 1, 2, 3].find((s) => !taken.has(s));
  if (slot === undefined) return { ok: false, reason: 'full' };

  const joined = await addMember(session.id, identity.userId, slot as 0 | 1 | 2 | 3);
  if (!joined.ok) return joined;

  return {
    ok: true,
    session: {
      id: session.id,
      joinCode: session.join_code,
      hostUserId: session.host_user_id,
      memberCount: (members?.length ?? 0) + 1,
      maxMembers: session.max_members,
      colorSlot: slot as 0 | 1 | 2 | 3,
    },
  };
}

async function addMember(
  sessionId: string,
  userId: string,
  colorSlot: 0 | 1 | 2 | 3,
): Promise<{ ok: true } | { ok: false; reason: 'error' | 'full'; message?: string }> {
  const supabase = getSupabase()!;
  const { error } = await supabase.from('sync_members').insert({
    session_id: sessionId,
    user_id: userId,
    color_slot: colorSlot,
    queue_pos: colorSlot,
  });

  if (!error) return { ok: true };
  // Two people scanning the same QR at the same instant race for a slot; the
  // unique index on (session_id, color_slot) is what settles it.
  if (error.code === '23505') return { ok: false, reason: 'full' };
  return { ok: false, reason: 'error', message: error.message };
}

export async function leaveSession(sessionId: string): Promise<void> {
  const supabase = getSupabase();
  const { data } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!supabase || !data.user) return;

  await supabase
    .from('sync_members')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', data.user.id);
}

export { JOIN_ALPHABET };
