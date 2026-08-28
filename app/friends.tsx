import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, LinearTransition, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { router } from 'expo-router';

import type { Relation, VisibleStats } from '../src/domain/friends.ts';
import { ensureIdentity } from '../src/data/auth.ts';
import { avatarUrls, pickAvatar, uploadAvatar } from '../src/data/avatars.ts';
import {
  loadFriends,
  removeFriend,
  respond,
  searchProfiles,
  sendRequest,
  type FriendProfile,
  type SearchResult,
} from '../src/data/friends.ts';
import { openCatalog } from '../src/data/catalog.ts';
import { importSharedRoutine } from '../src/data/routines.ts';
import { loadInbox, respondToShare, type InboxShare } from '../src/data/shares.ts';
import { isSupabaseConfigured } from '../src/data/supabase.ts';
import type { HapticGate } from '../src/motion/haptics.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useSettings, useTheme } from '../src/state/settings.ts';

function Button({
  label,
  onPress,
  gate,
  tone = 'ghost',
}: {
  label: string;
  onPress: () => void;
  gate: HapticGate;
  tone?: 'primary' | 'ghost' | 'danger';
}) {
  const theme = useTheme();
  const { gesture, style } = usePressScale({ onPress, gate });
  const bg = tone === 'primary' ? theme.accent : theme.surfaceAlt;
  const fg = tone === 'primary' ? theme.onAccent : tone === 'danger' ? theme.fail : theme.textDim;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 12,
            backgroundColor: bg,
            borderWidth: tone === 'primary' ? 0 : 1,
            borderColor: theme.line,
          },
          style,
        ]}
      >
        <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function Avatar({
  url,
  name,
  cacheKey,
  size = 44,
}: {
  url: string | null;
  name: string;
  /** Stable identity for the image cache. Never the display name — two friends
   *  called Ana would otherwise share one cached photo. */
  cacheKey: string;
  size?: number;
}) {
  const theme = useTheme();
  const initial = (name || '?').trim().charAt(0).toUpperCase();

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.surfaceAlt,
        borderWidth: 1,
        borderColor: theme.line,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {url ? (
        <Image
          // Signed URLs rotate on refresh, so the cache is keyed on the caller's
          // stable key rather than the URL — otherwise every re-sign is a fresh
          // download. `recyclingKey` additionally clears the view the instant
          // the identity changes, so a recycled row never flashes the previous
          // person's face.
          source={{ uri: url, cacheKey }}
          style={{ width: size, height: size }}
          contentFit="cover"
          recyclingKey={cacheKey}
          transition={180}
        />
      ) : (
        <Text style={{ color: theme.textFaint, fontSize: size * 0.38, fontWeight: '800' }}>
          {initial}
        </Text>
      )}
    </View>
  );
}

function StatsLine({ stats }: { stats: VisibleStats }) {
  const theme = useTheme();
  const parts: string[] = [];

  if (stats.workoutsThisWeek !== undefined) parts.push(`${stats.workoutsThisWeek} this week`);
  if (stats.currentStreakWeeks) parts.push(`${stats.currentStreakWeeks}-week streak`);
  if (stats.workoutsTotal !== undefined) parts.push(`${stats.workoutsTotal} total`);

  const top = stats.muscleSplit
    ? Object.entries(stats.muscleSplit).sort((a, b) => b[1] - a[1])[0]
    : undefined;
  if (top) parts.push(`mostly ${top[0].replace(/_/g, ' ')}`);

  if (parts.length === 0) return null;
  return (
    <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
      {parts.join(' · ')}
    </Text>
  );
}

const RELATION_ORDER: Record<Relation, number> = {
  incoming: 0,
  friends: 1,
  outgoing: 2,
  none: 3,
  'blocked-by-me': 4,
  'blocked-me': 5,
};

export default function FriendsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const [selfId, setSelfId] = useState<string | null>(null);
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxShare[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);

  const settings = useSettings((s) => s.settings);
  const loadSettings = useSettings((s) => s.load);
  const settingsLoaded = useSettings((s) => s.loaded);

  const lastAt = useSharedValue(0);
  const lastPriority = useSharedValue(0);
  const intensity = useSharedValue<number>(2);
  const gate: HapticGate = { lastAt, lastPriority, intensity };

  const configured = isSupabaseConfigured();

  const refresh = useCallback(async (id: string) => {
    setFriends((await loadFriends(id)).sort(
      (a, b) => RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation],
    ));
    setMyAvatar((await avatarUrls([id])).get(id) ?? null);
    setInbox(await loadInbox());
  }, []);

  useEffect(() => {
    if (!settingsLoaded) loadSettings();
  }, [loadSettings, settingsLoaded]);

  // Accepting a share substitutes exercises against this device's catalog, so
  // it has to be open before the button can do anything. Opening it here rather
  // than on tap keeps the wait off the moment the user is deciding.
  useEffect(() => {
    void openCatalog().then(() => setCatalogReady(true));
  }, []);

  useEffect(() => {
    if (!configured) return;
    void (async () => {
      const identity = await ensureIdentity();
      if (!identity) return;
      setSelfId(identity.userId);
      await refresh(identity.userId);
    })();
  }, [configured, refresh]);

  const onChangePhoto = useCallback(async () => {
    const picked = await pickAvatar();
    if (!picked.ok) {
      setNote(picked.reason === 'denied' ? 'Shift needs photo access to set an avatar.' : null);
      return;
    }
    setBusy(true);
    const result = await uploadAvatar(picked.uri);
    setBusy(false);
    if (!result.ok) {
      setNote('Upload failed.');
      return;
    }
    setNote(null);
    // Same user, same storage path, different bytes — without this the cache
    // would keep serving the photo that was just replaced.
    setAvatarVersion((v) => v + 1);
    if (selfId) await refresh(selfId);
  }, [refresh, selfId]);

  // Search as you type, debounced. Results carry photos so you can confirm the
  // person before sending anything — a request delivered to the wrong Ana
  // cannot be withdrawn from her side.
  useEffect(() => {
    if (!selfId || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found = await searchProfiles(query, selfId);
      if (!cancelled) {
        setResults(found);
        setSearching(false);
      }
    }, 280);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selfId]);

  const onSend = useCallback(
    async (result: SearchResult) => {
      if (!selfId) return;
      setBusy(true);
      const sent = await sendRequest(selfId, result.userId);
      setBusy(false);
      setNote(
        sent
          ? `Request sent to ${result.displayName ?? result.handle ?? 'them'}.`
          : 'Could not send that request.',
      );
      setQuery('');
      setResults([]);
      await refresh(selfId);
    },
    [refresh, selfId],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      await fn();
      setBusy(false);
      if (selfId) await refresh(selfId);
    },
    [refresh, selfId],
  );

  const selfCacheKey = `${selfId ?? 'me'}:${avatarVersion}`;

  /**
   * Import first, answer the server second.
   *
   * If the network drops between the two, the routine is already on the device
   * and the share simply appears once more. The other order loses it entirely.
   */
  const acceptShare = useCallback(
    async (share: InboxShare) => {
      setBusy(true);
      const result = importSharedRoutine(share.routine, 'friend', settings.availableEquipment);
      await respondToShare(share.id, 'accepted');
      setBusy(false);
      setInbox((current) => current.filter((s) => s.id !== share.id));

      setNote(
        result.adapted.substitutions > 0
          ? `Saved. ${result.adapted.substitutions} exercise${result.adapted.substitutions === 1 ? ' was' : 's were'} swapped for your equipment.`
          : 'Saved to your routines.',
      );
    },
    [settings.availableEquipment],
  );

  const dismissShare = useCallback(async (share: InboxShare) => {
    setInbox((current) => current.filter((s) => s.id !== share.id));
    await respondToShare(share.id, 'dismissed');
  }, []);

  const incoming = friends.filter((f) => f.relation === 'incoming');
  const accepted = friends.filter((f) => f.relation === 'friends');
  const outgoing = friends.filter((f) => f.relation === 'outgoing');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 20, paddingTop: insets.top + 20, paddingBottom: 60, gap: 20 }}
    >
      <View>
        <Text style={{ color: theme.text, fontSize: 34, fontWeight: '800' }}>Friends</Text>
        <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 4 }}>
          Consistency, not kilos. Nobody sees what is on your bar.
        </Text>
      </View>

      {!configured ? (
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: theme.warn, backgroundColor: theme.surface, padding: 14 }}>
          <Text style={{ color: theme.warn, fontSize: 12, fontWeight: '700' }}>Offline</Text>
          <Text style={{ color: theme.textDim, fontSize: 11, marginTop: 4, lineHeight: 16 }}>
            Friends need a Supabase project. Your workouts are logged locally either way.
          </Text>
        </View>
      ) : null}

      {inbox.length > 0 ? (
        <View className="gap-2">
          <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>
            SENT TO YOU · {inbox.length}
          </Text>
          {inbox.map((share) => (
            <Animated.View
              key={share.id}
              entering={FadeIn.duration(200)}
              exiting={FadeOut}
              layout={LinearTransition.springify()}
              style={{
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.accent,
                backgroundColor: theme.surface,
                padding: 14,
                gap: 10,
              }}
            >
              <View>
                <Text style={{ color: theme.text, fontSize: 16, fontWeight: '800' }}>
                  {share.routine.title}
                </Text>
                <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2 }}>
                  {share.routine.exercises.length} exercise
                  {share.routine.exercises.length === 1 ? '' : 's'}
                  {share.fromHandle ? ` · from @${share.fromHandle}` : ''}
                </Text>
                {share.message ? (
                  <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
                    “{share.message}”
                  </Text>
                ) : null}
              </View>

              <Text style={{ color: theme.textFaint, fontSize: 10, lineHeight: 15 }}>
                Their plan, your loads. Anything your gym cannot do is swapped for the closest
                thing it can.
              </Text>

              <View className="flex-row gap-2">
                <Button
                  label={catalogReady ? 'Save it' : 'Opening catalog…'}
                  tone="primary"
                  gate={gate}
                  onPress={() => {
                    if (catalogReady) void acceptShare(share);
                  }}
                />
                <Button label="No thanks" gate={gate} onPress={() => void dismissShare(share)} />
              </View>
            </Animated.View>
          ))}

          <Button label="Open my routines" gate={gate} onPress={() => router.push('/routines')} />
        </View>
      ) : null}

      {/* Your own photo */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          padding: 14,
        }}
      >
        <Avatar url={myAvatar} name="you" cacheKey={selfCacheKey} size={56} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>Your photo</Text>
          <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2, lineHeight: 15 }}>
            Only your friends can load it. Resized and stripped of location data before upload.
          </Text>
        </View>
        <Button label={myAvatar ? 'Change' : 'Add'} onPress={onChangePhoto} gate={gate} tone="primary" />
      </View>

      {/* Search by name or handle */}
      <View className="gap-2">
        <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>ADD SOMEONE</Text>
        <TextInput
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setNote(null);
          }}
          placeholder="Search by name or handle"
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            color: theme.text,
            fontSize: 15,
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: results.length > 0 ? theme.accent : theme.line,
            backgroundColor: theme.surface,
          }}
        />

        {searching ? (
          <Text style={{ color: theme.textFaint, fontSize: 11 }}>Searching…</Text>
        ) : null}

        {query.trim().length >= 2 && !searching && results.length === 0 ? (
          <Text style={{ color: theme.textFaint, fontSize: 11, lineHeight: 16 }}>
            Nobody found. They may have discovery turned off — ask them for their handle, or start a
            squad instead, which needs no friendship at all.
          </Text>
        ) : null}

        {/* Every result carries a face. Confirming who you are adding is the
            whole point: a request sent to the wrong person is not recoverable. */}
        {results.map((result) => (
          <Animated.View
            key={result.userId}
            entering={FadeIn.duration(160)}
            layout={LinearTransition.springify()}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: theme.line,
              backgroundColor: theme.surface,
              padding: 12,
            }}
          >
            <Avatar
              url={result.avatarUrl}
              name={result.displayName ?? result.handle ?? '?'}
              cacheKey={result.userId}
              size={48}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                {result.displayName ?? result.handle ?? 'Someone'}
              </Text>
              {result.handle ? (
                <Text style={{ color: theme.textFaint, fontSize: 12 }}>@{result.handle}</Text>
              ) : null}
            </View>
            {result.relation === 'friends' ? (
              <Text style={{ color: theme.pass, fontSize: 11, fontWeight: '700' }}>Friends</Text>
            ) : result.relation === 'outgoing' ? (
              <Text style={{ color: theme.textFaint, fontSize: 11 }}>Sent</Text>
            ) : result.relation === 'incoming' ? (
              <Button
                label="Accept"
                tone="primary"
                gate={gate}
                onPress={() => void act(() => respond(selfId!, result.userId, 'accepted'))}
              />
            ) : (
              <Button label="Add" tone="primary" gate={gate} onPress={() => void onSend(result)} />
            )}
          </Animated.View>
        ))}
      </View>

      {busy ? <ActivityIndicator color={theme.accent} /> : null}
      {note ? (
        <Animated.Text entering={FadeIn} exiting={FadeOut} style={{ color: theme.textDim, fontSize: 11 }}>
          {note}
        </Animated.Text>
      ) : null}

      {incoming.length > 0 ? (
        <View className="gap-2">
          <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>
            WANTS TO CONNECT
          </Text>
          {incoming.map((friend) => (
            <Animated.View
              key={friend.userId}
              layout={LinearTransition.springify()}
              entering={FadeIn}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.accent,
                backgroundColor: theme.surface,
                padding: 12,
              }}
            >
              <Avatar url={friend.avatarUrl} name={friend.handle ?? friend.userId} cacheKey={friend.userId} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>
                  {friend.displayName ?? friend.handle ?? 'Someone'}
                </Text>
                {friend.handle ? (
                  <Text style={{ color: theme.textFaint, fontSize: 11 }}>@{friend.handle}</Text>
                ) : null}
              </View>
              <Button
                label="Accept"
                tone="primary"
                gate={gate}
                onPress={() => void act(() => respond(selfId!, friend.userId, 'accepted'))}
              />
              <Button
                label="Block"
                tone="danger"
                gate={gate}
                onPress={() => void act(() => respond(selfId!, friend.userId, 'blocked'))}
              />
            </Animated.View>
          ))}
        </View>
      ) : null}

      <View className="gap-2">
        <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>
          FRIENDS · {accepted.length}
        </Text>
        {accepted.length === 0 ? (
          <Text style={{ color: theme.textFaint, fontSize: 12, lineHeight: 17 }}>
            Nobody yet. Add someone by handle above — or just start a squad, which needs no
            friendship at all.
          </Text>
        ) : (
          accepted.map((friend) => (
            <Animated.View
              key={friend.userId}
              layout={LinearTransition.springify()}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.line,
                backgroundColor: theme.surface,
                padding: 12,
              }}
            >
              <Avatar url={friend.avatarUrl} name={friend.handle ?? friend.userId} cacheKey={friend.userId} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>
                  {friend.displayName ?? friend.handle ?? 'Friend'}
                </Text>
                <StatsLine stats={friend.stats} />
              </View>
              <Button
                label="Remove"
                gate={gate}
                onPress={() => void act(() => removeFriend(selfId!, friend.userId))}
              />
            </Animated.View>
          ))
        )}
      </View>

      {outgoing.length > 0 ? (
        <View className="gap-2">
          <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>SENT</Text>
          {outgoing.map((friend) => (
            <View key={friend.userId} className="flex-row items-center gap-3">
              <Avatar url={null} name={friend.handle ?? '?'} cacheKey={friend.userId} size={32} />
              <Text style={{ color: theme.textDim, fontSize: 12, flex: 1 }}>
                @{friend.handle ?? 'pending'} — waiting
              </Text>
              <Button
                label="Cancel"
                gate={gate}
                onPress={() => void act(() => removeFriend(selfId!, friend.userId))}
              />
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
