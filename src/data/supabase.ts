import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client.
 *
 * Configured from `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
 * The anon key is public by design — it is shipped inside the app binary and is
 * only useful in combination with row level security, which every table has
 * (migration 0005). **No service-role key ever appears in this project**; the
 * only thing that needs one is applying migrations, which happens from a
 * developer's machine via the Supabase CLI.
 *
 * The client is created lazily so the app runs fully offline with no
 * configuration at all — which is the state it is in right now, and the state a
 * user in a basement gym is in regularly.
 */

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return typeof url === 'string' && url.length > 0 && typeof anonKey === 'string' && anonKey.length > 0;
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (client) return client;

  client = createClient(url!, anonKey!, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // React Native has no URL bar for a session to come back through.
      detectSessionInUrl: false,
    },
    realtime: {
      // Presence and broadcast carry ids and numbers, never objects. Four
      // clients deserialising a fat payload mid-gesture is the JS-thread
      // starvation risk that §4.7 exists to prevent.
      params: { eventsPerSecond: 10 },
    },
  });

  return client;
}

/** Clock offset against the server, for the shared rest timers (§2.5). */
export async function measureClockOffset(samples = 3): Promise<number> {
  const supabase = getSupabase();
  if (!supabase) return 0;

  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };

  for (let i = 0; i < samples; i++) {
    const sent = Date.now();
    const { data, error } = await supabase.rpc('server_now');
    const received = Date.now();
    if (error || !data) continue;

    const rtt = received - sent;
    // Assume symmetric latency: the server's clock read happened about halfway
    // through the round trip. Keeping only the lowest-RTT sample is what makes
    // this accurate enough to fire a squad-wide haptic in unison.
    const offset = Date.parse(String(data)) - (sent + rtt / 2);
    if (rtt < best.rtt) best = { rtt, offset };
  }

  return Number.isFinite(best.rtt) ? Math.round(best.offset) : 0;
}
