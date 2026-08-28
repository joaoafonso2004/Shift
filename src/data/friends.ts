import {
  canonicalPair,
  relationFor,
  visibleStats,
  type FriendStats,
  type Friendship,
  type PrivacySettings,
  type Relation,
  type VisibleStats,
} from '../domain/friends.ts';
import { avatarUrls } from './avatars.ts';
import { getSupabase } from './supabase.ts';

/**
 * Friend queries.
 *
 * Row level security is the real enforcement — `visibleStats` decides what to
 * render, the database decides what can be fetched. Either alone would be a
 * privacy bug waiting for the other to be bypassed.
 */

export interface FriendProfile {
  userId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  relation: Relation;
  stats: VisibleStats;
}

interface FriendshipRow {
  user_a: string;
  user_b: string;
  state: Friendship['state'];
  actor_id: string;
  created_at: string;
  responded_at: string | null;
}

function toFriendship(row: FriendshipRow): Friendship {
  return {
    userA: row.user_a,
    userB: row.user_b,
    state: row.state,
    actorId: row.actor_id,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

function otherParty(row: Friendship, selfId: string): string {
  return row.userA === selfId ? row.userB : row.userA;
}

/**
 * Everyone you are connected to, in any state.
 *
 * One query for the friendships, one for the profiles, one batch for the signed
 * avatar URLs — three round trips regardless of how many friends there are.
 */
export async function loadFriends(selfId: string): Promise<FriendProfile[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data: rows } = await supabase
    .from('friendships')
    .select('*')
    .or(`user_a.eq.${selfId},user_b.eq.${selfId}`);

  const friendships = (rows ?? []).map((r) => toFriendship(r as FriendshipRow));
  if (friendships.length === 0) return [];

  const ids = friendships.map((f) => otherParty(f, selfId));

  const [{ data: profiles }, { data: stats }, urls] = await Promise.all([
    supabase.from('profiles').select('id, handle, display_name, privacy').in('id', ids),
    supabase.from('friend_stats').select('*').in('user_id', ids),
    // Only friends' avatars are fetchable; storage RLS rejects the rest, and the
    // batch simply comes back without them.
    avatarUrls(
      friendships.filter((f) => f.state === 'accepted').map((f) => otherParty(f, selfId)),
    ),
  ]);

  const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  const statsById = new Map((stats ?? []).map((s) => [s.user_id as string, s]));

  return friendships.map((friendship) => {
    const userId = otherParty(friendship, selfId);
    const profile = profileById.get(userId);
    const relation = relationFor(friendship, selfId);
    const raw = statsById.get(userId);

    const privacy = (profile?.privacy ?? {}) as PrivacySettings;
    const full: FriendStats = {
      workoutsThisWeek: raw?.workouts_this_week ?? 0,
      workoutsTotal: raw?.workouts_total ?? 0,
      currentStreakWeeks: raw?.streak_weeks ?? 0,
      muscleSplit: (raw?.muscle_split ?? {}) as Record<string, number>,
      recentRecords: [],
      lastWorkoutAt: raw?.last_workout_at ?? null,
    };

    return {
      userId,
      handle: (profile?.handle as string | null) ?? null,
      displayName: (profile?.display_name as string | null) ?? null,
      avatarUrl: urls.get(userId) ?? null,
      relation,
      stats: visibleStats(full, privacy, relation),
    };
  });
}

export interface SearchResult {
  userId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Existing connection, so the row can say "already friends" rather than offering to add again. */
  relation: Relation;
}

/**
 * Search by handle or display name, with faces.
 *
 * People look for the name they know someone by, which is rarely the handle
 * that person picked — so an exact-handle lookup only helps someone who already
 * knew the handle, and they did not need to search.
 *
 * Avatars come back in the same batch as the results, because a faceless search
 * result is not enough to identify anyone. Confirming *before* sending matters:
 * a request delivered to the wrong person cannot be withdrawn from their side.
 */
export async function searchProfiles(
  query: string,
  selfId: string,
  limit = 20,
): Promise<SearchResult[]> {
  const supabase = getSupabase();
  const trimmed = query.trim();
  if (!supabase || trimmed.length < 2) return [];

  const { data, error } = await supabase.rpc('search_profiles', {
    p_query: trimmed,
    p_limit: limit,
  });
  if (error || !data) return [];

  const rows = data as { id: string; handle: string | null; display_name: string | null }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  // Existing connections, so a result can say "already friends" instead of
  // offering to add someone twice.
  const [{ data: links }, urls] = await Promise.all([
    supabase
      .from('friendships')
      .select('*')
      .or(`user_a.eq.${selfId},user_b.eq.${selfId}`),
    avatarUrls(ids),
  ]);

  const byOther = new Map<string, Friendship>();
  for (const row of links ?? []) {
    const friendship = toFriendship(row as FriendshipRow);
    byOther.set(otherParty(friendship, selfId), friendship);
  }

  return rows.map((row) => ({
    userId: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: urls.get(row.id) ?? null,
    relation: relationFor(byOther.get(row.id) ?? null, selfId),
  }));
}

export async function sendRequest(selfId: string, otherId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const [userA, userB] = canonicalPair(selfId, otherId);

  // If they already invited you, this is mutual consent — accept rather than
  // leaving two people each staring at an invitation they already sent.
  const { data: existing } = await supabase
    .from('friendships')
    .select('*')
    .eq('user_a', userA)
    .eq('user_b', userB)
    .maybeSingle();

  if (existing) {
    const row = toFriendship(existing as FriendshipRow);
    if (row.state === 'blocked' || row.state === 'accepted') return false;
    if (row.actorId === selfId) return false;
    return respond(selfId, otherId, 'accepted');
  }

  const { error } = await supabase.from('friendships').insert({
    user_a: userA,
    user_b: userB,
    state: 'pending',
    actor_id: selfId,
  });

  return !error;
}

export async function respond(
  selfId: string,
  otherId: string,
  state: 'accepted' | 'blocked',
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const [userA, userB] = canonicalPair(selfId, otherId);
  const { error } = await supabase
    .from('friendships')
    .update({
      state,
      responded_at: new Date().toISOString(),
      // Blocking transfers ownership of the row, so the blocked party cannot
      // simply accept their way back in.
      ...(state === 'blocked' ? { actor_id: selfId } : {}),
    })
    .eq('user_a', userA)
    .eq('user_b', userB);

  return !error;
}

export async function removeFriend(selfId: string, otherId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const [userA, userB] = canonicalPair(selfId, otherId);
  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('user_a', userA)
    .eq('user_b', userB);

  return !error;
}

export async function reportUser(
  selfId: string,
  reportedId: string,
  reason: string,
  detail?: string,
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase.from('user_reports').upsert(
    { reporter_id: selfId, reported_id: reportedId, reason, detail: detail ?? null },
    { onConflict: 'reporter_id,reported_id' },
  );

  return !error;
}
