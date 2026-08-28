import { parseSharedRoutine, type SharedRoutine } from '../domain/sharing.ts';
import { getSupabase } from './supabase.ts';

/**
 * Sending a routine to a friend, and reading what was sent to you.
 *
 * The payload crossing this boundary was written by another user, so every
 * inbox row goes through `parseSharedRoutine` before anything looks at it —
 * even though the same client wrote it and a check constraint bounded its size.
 * Row level security decides *whether* you can read a row; it has no opinion on
 * whether the jsonb inside is shaped like a routine.
 *
 * Nothing here can carry a load. There is no weight field in the payload type,
 * so there is none on the wire (invariant 13).
 */

export interface InboxShare {
  id: string;
  fromUserId: string;
  fromHandle: string | null;
  fromDisplayName: string | null;
  message: string | null;
  createdAt: string;
  routine: SharedRoutine;
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-configured' | 'not-friends' | 'duplicate' | 'error'; message?: string };

/**
 * Send a routine.
 *
 * The friendship requirement is enforced by the insert policy, not here — this
 * function only translates what the database said back into something the UI
 * can put in front of a person. A client-side check would be a courtesy; the
 * policy is the rule.
 */
export async function sendRoutine(
  toUserId: string,
  routine: SharedRoutine,
  message?: string | null,
): Promise<SendOutcome> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: 'not-configured' };

  const { data: auth } = await supabase.auth.getUser();
  const fromUserId = auth.user?.id;
  if (!fromUserId) return { ok: false, reason: 'error', message: 'no session' };

  const { error } = await supabase.from('shared_routines').insert({
    from_user_id: fromUserId,
    to_user_id: toUserId,
    payload: routine,
    message: message ?? null,
  });

  if (!error) return { ok: true };

  // 23505 is the partial unique index: the same routine is already sitting
  // unanswered in their inbox. Not a failure worth alarming anyone about.
  if (error.code === '23505') return { ok: false, reason: 'duplicate' };
  // 42501 is the insert policy refusing — you are not friends, or one of you
  // has blocked the other. The policy will not say which, and neither should we.
  if (error.code === '42501') return { ok: false, reason: 'not-friends' };

  return { ok: false, reason: 'error', message: error.message };
}

interface InboxRow {
  id: string;
  from_user_id: string;
  message: string | null;
  created_at: string;
  payload: unknown;
}

/**
 * Everything waiting for you, newest first.
 *
 * Two queries: the shares, then one batch for the senders' profiles. A join
 * through PostgREST would work, but the profile read has its own policy and a
 * failure there would take the whole inbox with it rather than costing one row
 * its handle.
 *
 * A row whose payload does not parse is dropped rather than surfaced. There is
 * nothing a user can do about a malformed routine, and rendering an error card
 * for one only teaches them to ignore the inbox.
 */
export async function loadInbox(): Promise<InboxShare[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('shared_routines')
    .select('id, from_user_id, message, created_at, payload')
    .eq('state', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) return [];

  const rows = data as InboxRow[];
  const senderIds = [...new Set(rows.map((row) => row.from_user_id))];

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, handle, display_name')
    .in('id', senderIds);

  const byId = new Map(
    (profiles ?? []).map((p) => [
      p.id as string,
      { handle: (p.handle as string) ?? null, displayName: (p.display_name as string) ?? null },
    ]),
  );

  const out: InboxShare[] = [];
  for (const row of rows) {
    const parsed = parseSharedRoutine(row.payload);
    if (!parsed.ok) continue;

    const sender = byId.get(row.from_user_id);
    out.push({
      id: row.id,
      fromUserId: row.from_user_id,
      fromHandle: sender?.handle ?? null,
      fromDisplayName: sender?.displayName ?? null,
      message: row.message,
      createdAt: row.created_at,
      // The sender's handle is taken from their profile, never from the payload:
      // the payload is a string the sender chose, and a handle is an identity.
      routine: { ...parsed.routine, fromHandle: sender?.handle ?? parsed.routine.fromHandle },
    });
  }

  return out;
}

/**
 * Answer a share.
 *
 * Accepting on the server and importing locally are separate steps, and the
 * import goes first at the call site. A routine copied to the device with the
 * server write still in flight is recoverable — the row stays pending and the
 * user sees it once more. The reverse order loses the routine entirely if the
 * network drops between the two.
 */
export async function respondToShare(id: string, state: 'accepted' | 'dismissed'): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  // `.select()` is load-bearing, not decoration.
  //
  // The update policy's USING clause *filters* rather than raising: a share
  // that has already been answered, or that belongs to someone else, is simply
  // not visible to the statement. PostgREST reports no error and zero rows, so
  // checking only `error` would report success for a write that did nothing.
  // Asking for the rows back is the only way to know one was touched.
  const { data, error } = await supabase
    .from('shared_routines')
    .update({ state, responded_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');

  return !error && (data?.length ?? 0) > 0;
}

/** Take back something you sent, provided they have not answered it. */
export async function withdrawShare(id: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase.from('shared_routines').delete().eq('id', id);
  return !error;
}
