import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, LinearTransition, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { router } from 'expo-router';

import {
  formatJoinCode,
  isValidJoinCode,
  JOIN_CODE_LENGTH,
  joinCodeUrl,
  normalizeJoinCode,
} from '../src/domain/joinCode.ts';
import { createSession, joinByCode, type SessionSummary } from '../src/data/session.ts';
import { isSupabaseConfigured } from '../src/data/supabase.ts';
import type { HapticGate } from '../src/motion/haptics.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useCoop } from '../src/state/coop.ts';
import { useInbound } from '../src/state/inbound.ts';

const SLOT_HUE = ['#4f8cff', '#ff8a4f', '#3ddc97', '#c77dff'] as const;

const FAILURE_COPY: Record<string, string> = {
  'not-configured': 'Shift is running offline. Add your Supabase keys to .env to train together.',
  'no-identity': "Couldn't sign in. Check that anonymous sign-in is enabled in Supabase.",
  'not-found': "No session with that code. Check the characters and try again.",
  full: 'That squad is full — four is the limit.',
  expired: 'That session has ended. Ask for a fresh code.',
  error: 'Something went wrong reaching the session.',
};

function Button({
  label,
  onPress,
  gate,
  tone = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  gate: HapticGate;
  tone?: 'primary' | 'ghost';
  disabled?: boolean;
}) {
  const { gesture, style } = usePressScale({ onPress, gate, enabled: !disabled });
  const primary = tone === 'primary';
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderRadius: 16,
            alignItems: 'center',
            backgroundColor: primary ? '#4f8cff' : '#12141a',
            borderWidth: primary ? 0 : 1,
            borderColor: '#1e2129',
            opacity: disabled ? 0.4 : 1,
          },
          style,
        ]}
      >
        <Text
          style={{
            color: primary ? '#08090c' : '#9aa1ae',
            fontSize: 15,
            fontWeight: '800',
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

/** The code, big enough to read across a gym, plus a QR so nobody has to type. */
function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <Animated.View
      entering={FadeIn.duration(260)}
      layout={LinearTransition.springify()}
      className="rounded-3xl border border-ink-line bg-ink-soft p-6 items-center gap-4"
    >
      <Text className="text-chalk-faint text-[10px] uppercase tracking-widest">Join code</Text>
      <Text
        selectable
        style={{
          color: '#f4f5f7',
          fontSize: 46,
          fontWeight: '800',
          letterSpacing: 6,
          fontVariant: ['tabular-nums'],
        }}
      >
        {formatJoinCode(session.joinCode)}
      </Text>

      <View className="rounded-2xl bg-chalk p-3">
        <QRCode value={joinCodeUrl(session.joinCode)} size={148} backgroundColor="#f4f5f7" />
      </View>

      <View className="flex-row items-center gap-2">
        {[0, 1, 2, 3].map((slot) => (
          <View
            key={slot}
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor:
                slot < session.memberCount ? (SLOT_HUE[slot] ?? '#5b6270') : '#1e2129',
            }}
          />
        ))}
        <Text className="text-chalk-faint text-[11px] ml-1">
          {session.memberCount} of {session.maxMembers}
        </Text>
      </View>

      <Text className="text-chalk-faint text-[10px] text-center leading-4">
        Scanning the code opens Shift with it already filled in. Sessions expire after six hours.
      </Text>
    </Animated.View>
  );
}

export default function SquadScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'choose' | 'joining'>('choose');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);

  const join = useCoop((s) => s.join);

  // A scanned QR or a tapped link fills the code in and opens the keypad, but
  // does not join on its own. One deliberate tap is the difference between
  // "scanning put me in the squad" and "a link I did not read put me in someone
  // else's session" — and after pointing a camera at a screen, the tap costs
  // nothing.
  const inboundCode = useInbound((s) => s.squadCode);
  const clearSquadCode = useInbound((s) => s.clearSquadCode);

  useEffect(() => {
    if (!inboundCode) return;
    setCode(inboundCode);
    setMode('joining');
    setError(null);
    clearSquadCode();
  }, [inboundCode, clearSquadCode]);

  const lastAt = useSharedValue(0);
  const lastPriority = useSharedValue(0);
  const intensity = useSharedValue(2);
  const gate: HapticGate = { lastAt, lastPriority, intensity };

  const configured = isSupabaseConfigured();

  const enter = useCallback(
    async (result: Awaited<ReturnType<typeof createSession>>) => {
      if (!result.ok) {
        setError(FAILURE_COPY[result.reason] ?? FAILURE_COPY.error!);
        return;
      }
      setError(null);
      setSession(result.session);
      await join(result.session.id);
    },
    [join],
  );

  const onCreate = useCallback(async () => {
    setBusy(true);
    await enter(await createSession());
    setBusy(false);
  }, [enter]);

  const onJoin = useCallback(async () => {
    setBusy(true);
    await enter(await joinByCode(code));
    setBusy(false);
  }, [code, enter]);

  const normalized = normalizeJoinCode(code);
  const canSubmit = isValidJoinCode(normalized) && !busy;

  return (
    <View
      className="flex-1 bg-ink px-5 gap-5"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }}
    >
      <View>
        <Text className="text-chalk text-4xl font-bold tracking-tight">Squad</Text>
        <Text className="text-chalk-faint text-sm mt-1">
          Train together, in the same room. Two to four people.
        </Text>
      </View>

      {!configured ? (
        <View className="rounded-2xl border border-warn bg-ink-soft p-4">
          <Text className="text-warn text-xs font-bold">Offline</Text>
          <Text className="text-chalk-dim text-[11px] mt-1 leading-4">
            Squads need a Supabase project. Everything else in Shift works without one — your
            workouts are logged locally either way.
          </Text>
        </View>
      ) : null}

      {session ? (
        <SessionCard session={session} />
      ) : (
        <Animated.View layout={LinearTransition.springify()} className="gap-3">
          {mode === 'choose' ? (
            <Animated.View entering={FadeIn} exiting={FadeOut} className="gap-3">
              <Button label="Start a squad" onPress={onCreate} gate={gate} disabled={!configured || busy} />
              <Button
                label="Join with a code"
                tone="ghost"
                onPress={() => setMode('joining')}
                gate={gate}
                disabled={!configured || busy}
              />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn} exiting={FadeOut} className="gap-3">
              <TextInput
                value={code}
                onChangeText={(text) => {
                  setCode(normalizeJoinCode(text));
                  setError(null);
                }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                maxLength={JOIN_CODE_LENGTH}
                placeholder="A3F9K2"
                placeholderTextColor="#5b6270"
                style={{
                  color: '#f4f5f7',
                  fontSize: 34,
                  fontWeight: '800',
                  letterSpacing: 8,
                  textAlign: 'center',
                  paddingVertical: 18,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: canSubmit ? '#4f8cff' : '#1e2129',
                  backgroundColor: '#12141a',
                }}
              />
              <Button label="Join" onPress={onJoin} gate={gate} disabled={!canSubmit} />
              <Button
                label="Back"
                tone="ghost"
                onPress={() => {
                  setMode('choose');
                  setCode('');
                  setError(null);
                }}
                gate={gate}
              />
            </Animated.View>
          )}
        </Animated.View>
      )}

      {busy ? <ActivityIndicator color="#4f8cff" /> : null}

      {error ? (
        <Animated.View entering={FadeIn} className="rounded-2xl border border-fail bg-ink-soft p-3">
          <Text className="text-fail text-[11px] leading-4">{error}</Text>
        </Animated.View>
      ) : null}

      <View style={{ flex: 1 }} />

      {session ? (
        <Button label="Go to workout" onPress={() => router.push('/workout')} gate={gate} />
      ) : null}

      <Pressable onPress={() => router.back()} hitSlop={12}>
        <Text className="text-chalk-faint text-xs text-center">Not now</Text>
      </Pressable>
    </View>
  );
}
