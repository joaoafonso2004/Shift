import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';

import { getSupabase } from './supabase.ts';

/**
 * Profile photos.
 *
 * Stored in a **private** bucket. A public bucket would make every profile photo
 * readable by anyone holding the URL, forever, regardless of what the friendship
 * says — and "you can see your friends'" has to actually mean something.
 *
 * The cost is real: private objects are read through signed URLs, which expire
 * and therefore defeat naive image caching. Two things pay that down — URLs are
 * fetched in **one batch** for a whole friends list rather than one request per
 * avatar, and they are cached in memory until shortly before they expire.
 */

const BUCKET = 'avatars';
const SIGNED_TTL_S = 3600;
/** Refresh a little early so an image never fails mid-scroll. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Small on purpose: an avatar is never shown larger than a few hundred points. */
const AVATAR_SIZE = 512;

interface CachedUrl {
  url: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedUrl>();

export function avatarPath(userId: string): string {
  return `${userId}/avatar.jpg`;
}

/**
 * Signed URLs for many users at once.
 *
 * One round trip for a whole list. Requesting per-avatar turns a 30-friend list
 * into 30 requests, which on gym wifi is the difference between a list that
 * appears and a list that trickles.
 */
export async function avatarUrls(userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const stale: string[] = [];

  for (const id of userIds) {
    const hit = cache.get(id);
    if (hit && hit.expiresAtMs - REFRESH_MARGIN_MS > now) out.set(id, hit.url);
    else stale.push(id);
  }

  const supabase = getSupabase();
  if (!supabase || stale.length === 0) return out;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(stale.map(avatarPath), SIGNED_TTL_S);

  if (error || !data) return out;

  for (const entry of data) {
    if (!entry.signedUrl || entry.error) continue;
    // `path` comes back as `<userId>/avatar.jpg`.
    const userId = entry.path?.split('/')[0];
    if (!userId) continue;
    cache.set(userId, { url: entry.signedUrl, expiresAtMs: now + SIGNED_TTL_S * 1000 });
    out.set(userId, entry.signedUrl);
  }

  return out;
}

export function forgetAvatar(userId: string): void {
  cache.delete(userId);
}

export type PickOutcome =
  | { ok: true; uri: string }
  | { ok: false; reason: 'denied' | 'cancelled' };

/**
 * Ask for a photo.
 *
 * Permission is requested at the moment it is needed rather than at launch, so
 * the prompt arrives with obvious context.
 */
export async function pickAvatar(): Promise<PickOutcome> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { ok: false, reason: 'denied' };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });

  if (result.canceled || !result.assets[0]) return { ok: false, reason: 'cancelled' };
  return { ok: true, uri: result.assets[0].uri };
}

/**
 * Resize and re-encode before upload.
 *
 * A modern phone camera produces several megabytes; an avatar is displayed at
 * well under 200 points. Uploading the original wastes the user's data on a
 * gym connection and every viewer's data afterwards, forever. Re-encoding also
 * strips EXIF — a photo straight from the camera roll carries GPS coordinates,
 * and a profile picture should not tell your friends where you live.
 */
export async function prepareAvatar(uri: string): Promise<{ uri: string; bytes: number }> {
  const context = ImageManipulator.ImageManipulator.manipulate(uri).resize({
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  });

  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    compress: 0.82,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  const file = new File(saved.uri);
  return { uri: saved.uri, bytes: file.size ?? 0 };
}

export type UploadOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-configured' | 'no-session' | 'error'; message?: string };

export async function uploadAvatar(localUri: string): Promise<UploadOutcome> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: 'not-configured' };

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return { ok: false, reason: 'no-session' };

  const prepared = await prepareAvatar(localUri);
  const bytes = await new File(prepared.uri).bytes();
  const path = avatarPath(userId);

  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: 'image/jpeg',
    upsert: true,
  });

  if (error) return { ok: false, reason: 'error', message: error.message };

  await supabase.from('profiles').update({ avatar_path: path }).eq('id', userId);
  // The old signed URL still points at the previous image.
  forgetAvatar(userId);

  return { ok: true, path };
}

export async function removeAvatar(): Promise<void> {
  const supabase = getSupabase();
  const { data } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!supabase || !data.user) return;

  await supabase.storage.from(BUCKET).remove([avatarPath(data.user.id)]);
  await supabase.from('profiles').update({ avatar_path: null }).eq('id', data.user.id);
  forgetAvatar(data.user.id);
}
