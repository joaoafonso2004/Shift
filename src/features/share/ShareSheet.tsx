import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, LinearTransition, SlideInDown } from 'react-native-reanimated';

import { ensureIdentity } from '../../data/auth.ts';
import { loadFriends, type FriendProfile } from '../../data/friends.ts';
import { sendRoutine } from '../../data/shares.ts';
import { isSupabaseConfigured } from '../../data/supabase.ts';
import { routineLink } from '../../data/links.ts';
import type { SharedRoutine } from '../../domain/sharing.ts';
import type { HapticGate } from '../../motion/haptics.ts';
import { springs } from '../../motion/springs.ts';
import { usePressScale } from '../../motion/usePressScale.ts';
import { useTheme } from '../../state/settings.ts';

/**
 * Send a routine — to a friend inside the app, or to anyone as a link.
 *
 * Both paths exist because they answer different questions. Sending to a friend
 * lands in their inbox with your handle on it and no copy-paste; a link reaches
 * someone who has not installed Shift yet, through whatever they already use to
 * talk to you. An app that only offers the first one cannot be used to invite
 * anybody.
 */

type SendState = 'idle' | 'sending' | 'sent' | 'duplicate' | 'failed';

function Row({
  label,
  sublabel,
  state,
  onPress,
  gate,
}: {
  label: string;
  sublabel?: string | null;
  state: SendState;
  onPress: () => void;
  gate: HapticGate;
}) {
  const theme = useTheme();
  const { gesture, style } = usePressScale({ onPress, gate, enabled: state === 'idle' });

  const status =
    state === 'sent'
      ? { text: 'Sent', color: theme.pass }
      : state === 'duplicate'
        ? { text: 'Already sent', color: theme.textFaint }
        : state === 'failed'
          ? { text: 'Failed', color: theme.fail }
          : { text: 'Send', color: theme.accent };

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        layout={LinearTransition.springify()}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme.line,
            backgroundColor: theme.surface,
          },
          style,
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
            {label}
          </Text>
          {sublabel ? (
            <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {sublabel}
            </Text>
          ) : null}
        </View>

        {state === 'sending' ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <Text style={{ color: status.color, fontSize: 12, fontWeight: '800' }}>{status.text}</Text>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

export function ShareSheet({
  routine,
  onClose,
  gate,
}: {
  /** Null closes the sheet. Passing the routine in is what opens it. */
  routine: SharedRoutine | null;
  onClose: () => void;
  gate: HapticGate;
}) {
  const theme = useTheme();
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [states, setStates] = useState<Record<string, SendState>>({});

  const configured = isSupabaseConfigured();

  useEffect(() => {
    if (!routine || !configured) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      const identity = await ensureIdentity();
      if (identity && !cancelled) {
        const all = await loadFriends(identity.userId);
        if (!cancelled) setFriends(all.filter((f) => f.relation === 'friends'));
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [routine, configured]);

  // Each send is tracked per friend rather than by one sheet-wide flag, so
  // sending to three people in a row shows three results instead of the last one.
  const send = useCallback(
    async (friend: FriendProfile) => {
      if (!routine) return;
      setStates((s) => ({ ...s, [friend.userId]: 'sending' }));
      const result = await sendRoutine(friend.userId, routine);
      setStates((s) => ({
        ...s,
        [friend.userId]: result.ok ? 'sent' : result.reason === 'duplicate' ? 'duplicate' : 'failed',
      }));
    },
    [routine],
  );

  const shareLink = useCallback(async () => {
    if (!routine) return;
    const link = routineLink(routine);
    // The system sheet, so the routine goes wherever this person already talks:
    // WhatsApp, Messages, a note to themselves. `message` rather than `url`
    // because a custom scheme in the url field is dropped by some targets.
    await Share.share({ message: `${routine.title}\n${link}` });
  }, [routine]);

  if (!routine) return null;

  const summary = `${routine.exercises.length} exercise${routine.exercises.length === 1 ? '' : 's'}`;

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(140)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'flex-end',
        backgroundColor: theme.isDark ? 'rgba(0,0,0,0.62)' : 'rgba(20,22,28,0.38)',
      }}
    >
      {/* Tapping away closes. A plain Pressable, not a gesture: this is a
          dismissal, not something that needs to track a finger. */}
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />

      <Animated.View
        // Physics from springs.ts, never inline: `sheet` is the config this
        // exact motion exists for, and duration + dampingRatio is the form that
        // settles identically at 60 and 120 Hz.
        entering={SlideInDown.springify()
          .duration(springs.sheet.duration)
          .dampingRatio(springs.sheet.dampingRatio)
          .reduceMotion(springs.sheet.reduceMotion)}
        style={{
          backgroundColor: theme.bg,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          borderWidth: 1,
          borderColor: theme.line,
          padding: 20,
          paddingBottom: 34,
          gap: 12,
          maxHeight: '78%',
        }}
      >
        <View>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800' }}>Share</Text>
          <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 3, lineHeight: 17 }}>
            {routine.title} · {summary}. Your weights stay yours — they get the plan and their own
            predicted loads.
          </Text>
        </View>

        <Row label="Send as a link" sublabel="Works even if they don't have Shift" state="idle" onPress={() => void shareLink()} gate={gate} />

        <View style={{ height: 1, backgroundColor: theme.line, marginVertical: 2 }} />

        {!configured ? (
          <Text style={{ color: theme.textFaint, fontSize: 12, lineHeight: 17 }}>
            Sending to a friend needs a Supabase project. The link above works offline.
          </Text>
        ) : loading ? (
          <ActivityIndicator color={theme.accent} />
        ) : friends.length === 0 ? (
          <Text style={{ color: theme.textFaint, fontSize: 12, lineHeight: 17 }}>
            No friends yet. Add someone on the Friends screen, or send the link.
          </Text>
        ) : (
          friends.map((friend) => (
            <Row
              key={friend.userId}
              label={friend.displayName ?? friend.handle ?? 'Friend'}
              sublabel={friend.handle ? `@${friend.handle}` : null}
              state={states[friend.userId] ?? 'idle'}
              onPress={() => void send(friend)}
              gate={gate}
            />
          ))
        )}
      </Animated.View>
    </Animated.View>
  );
}
