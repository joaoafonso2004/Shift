import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, LinearTransition, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { openCatalog } from '../src/data/catalog.ts';
import { openLocalDb } from '../src/data/localDb.ts';
import {
  deleteRoutine,
  getRoutine,
  listRoutines,
  type RoutineSummary,
} from '../src/data/repository.ts';
import { adaptContextFor, importSharedRoutine, startRoutineById } from '../src/data/routines.ts';
import { adaptRoutine, type AdaptedRoutine, type SharedRoutine } from '../src/domain/sharing.ts';
import { ShareSheet } from '../src/features/share/ShareSheet.tsx';
import type { HapticGate } from '../src/motion/haptics.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useInbound } from '../src/state/inbound.ts';
import { useSettings, useTheme } from '../src/state/settings.ts';
import { useWorkout } from '../src/state/workout.ts';

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
  const primary = tone === 'primary';

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 9,
            paddingHorizontal: 14,
            borderRadius: 12,
            backgroundColor: primary ? theme.accent : theme.surfaceAlt,
            borderWidth: primary ? 0 : 1,
            borderColor: theme.line,
          },
          style,
        ]}
      >
        <Text
          style={{
            color: primary ? theme.onAccent : tone === 'danger' ? theme.fail : theme.textDim,
            fontSize: 12,
            fontWeight: '800',
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * What a routine turns into on *this* phone, before it is accepted.
 *
 * Substitutions are shown as a struck-through original next to its replacement.
 * A routine that quietly becomes a different routine is worse than one with a
 * gap in it, because there is no way to tell it happened.
 */
function InboundPreview({
  routine,
  adapted,
  onAccept,
  onDismiss,
  gate,
}: {
  routine: SharedRoutine;
  adapted: AdaptedRoutine;
  onAccept: () => void;
  onDismiss: () => void;
  gate: HapticGate;
}) {
  const theme = useTheme();

  return (
    <Animated.View
      entering={FadeIn.duration(220)}
      exiting={FadeOut}
      layout={LinearTransition.springify()}
      style={{
        borderRadius: 24,
        borderWidth: 1,
        borderColor: theme.accent,
        backgroundColor: theme.surface,
        padding: 18,
        gap: 12,
      }}
    >
      <View>
        <Text style={{ color: theme.accent, fontSize: 10, letterSpacing: 1.2, fontWeight: '800' }}>
          SHARED WITH YOU
        </Text>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800', marginTop: 4 }}>
          {routine.title}
        </Text>
        {routine.fromHandle ? (
          <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 2 }}>
            from @{routine.fromHandle}
          </Text>
        ) : null}
        {routine.note ? (
          <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
            “{routine.note}”
          </Text>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>
        {adapted.items.map((item, index) => (
          <View key={`${item.requested.exerciseId}-${index}`} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={{ color: theme.textFaint, fontSize: 12, width: 46 }}>
              {item.requested.sets}×{item.requested.reps}
            </Text>
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: item.status === 'unavailable' ? theme.textFaint : theme.text,
                  fontSize: 13,
                  textDecorationLine: item.status === 'unavailable' ? 'line-through' : 'none',
                }}
                numberOfLines={1}
              >
                {item.exercise?.name ?? item.requested.name ?? item.requested.exerciseId}
              </Text>
              {item.status !== 'kept' ? (
                <Text style={{ color: theme.warn, fontSize: 10, marginTop: 1 }} numberOfLines={2}>
                  {item.substitutedFrom ? `replaces ${item.substitutedFrom.name} — ` : ''}
                  {item.reason}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>

      <Text style={{ color: theme.textFaint, fontSize: 11, lineHeight: 16 }}>
        No weights travel. Every load is predicted from your own history the first time you run it.
      </Text>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Add to my routines" tone="primary" onPress={onAccept} gate={gate} />
        <Button label="No thanks" onPress={onDismiss} gate={gate} />
      </View>
    </Animated.View>
  );
}

export default function RoutinesScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const [ready, setReady] = useState(false);
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [sharing, setSharing] = useState<SharedRoutine | null>(null);

  const settings = useSettings((s) => s.settings);
  const loadSettings = useSettings((s) => s.load);
  const settingsLoaded = useSettings((s) => s.loaded);

  const inbound = useInbound((s) => s.routine);
  const clearInbound = useInbound((s) => s.clearRoutine);

  const startRoutine = useWorkout((s) => s.startRoutine);

  const lastAt = useSharedValue(0);
  const lastPriority = useSharedValue(0);
  const intensity = useSharedValue<number>(2);
  const gate = useMemo<HapticGate>(
    () => ({ lastAt, lastPriority, intensity }),
    [lastAt, lastPriority, intensity],
  );
  intensity.value = settings.hapticIntensity;

  useEffect(() => {
    if (!settingsLoaded) loadSettings();
  }, [loadSettings, settingsLoaded]);

  // The catalog has to be open before anything can be named or substituted —
  // both the list and the inbound preview read it.
  useEffect(() => {
    let cancelled = false;
    void openCatalog().then(() => {
      if (cancelled) return;
      setRoutines(listRoutines(openLocalDb()));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => setRoutines(listRoutines(openLocalDb())), []);

  // Adapting is a catalog read per exercise, so it is done once when a routine
  // arrives rather than on every render of the preview.
  const adaptedInbound = useMemo(() => {
    if (!inbound || !ready) return null;
    return adaptRoutine(inbound, adaptContextFor(settings.availableEquipment));
  }, [inbound, ready, settings.availableEquipment]);

  const acceptInbound = useCallback(() => {
    if (!inbound) return;
    importSharedRoutine(inbound, 'link', settings.availableEquipment);
    clearInbound();
    refresh();
  }, [inbound, settings.availableEquipment, clearInbound, refresh]);

  const start = useCallback(
    (id: string) => {
      const ids = startRoutineById(id);
      if (ids.length === 0) return;
      startRoutine(ids, id);
      router.push('/workout');
    },
    [startRoutine],
  );

  const share = useCallback((summary: RoutineSummary) => {
    const stored = getRoutine(openLocalDb(), summary.id);
    if (!stored) return;

    setSharing({
      version: 1,
      title: stored.title,
      note: stored.note,
      fromHandle: null,
      createdAt: stored.createdAt,
      exercises: stored.exercises.map((exercise) => ({
        exerciseId: exercise.exerciseId,
        name: '',
        sets: exercise.sets,
        reps: exercise.reps,
        ...(exercise.restS !== null ? { restS: exercise.restS } : {}),
      })),
    });
  }, []);

  const remove = useCallback(
    (id: string) => {
      deleteRoutine(openLocalDb(), id);
      setConfirmingId(null);
      refresh();
    },
    [refresh],
  );

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 60,
          gap: 16,
        }}
      >
        <View>
          <Text style={{ color: theme.text, fontSize: 34, fontWeight: '800' }}>Routines</Text>
          <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 4, lineHeight: 17 }}>
            Yours, and the ones people sent you. Weights are always your own.
          </Text>
        </View>

        {inbound && adaptedInbound ? (
          <InboundPreview
            routine={inbound}
            adapted={adaptedInbound}
            onAccept={acceptInbound}
            onDismiss={clearInbound}
            gate={gate}
          />
        ) : null}

        {routines.length === 0 ? (
          <View
            style={{
              borderRadius: 20,
              borderWidth: 1,
              borderColor: theme.line,
              backgroundColor: theme.surface,
              padding: 16,
              gap: 6,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>Nothing saved yet</Text>
            <Text style={{ color: theme.textFaint, fontSize: 12, lineHeight: 17 }}>
              Finish a workout and save it, or open a routine somebody sent you. The starter routine
              is always available from Today.
            </Text>
          </View>
        ) : (
          routines.map((routine) => (
            <Animated.View
              key={routine.id}
              layout={LinearTransition.springify()}
              style={{
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.line,
                backgroundColor: theme.surface,
                padding: 16,
                gap: 10,
              }}
            >
              <View>
                <Text style={{ color: theme.text, fontSize: 17, fontWeight: '800' }}>
                  {routine.title}
                </Text>
                <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 3 }}>
                  {routine.exerciseCount} exercise{routine.exerciseCount === 1 ? '' : 's'}
                  {routine.fromHandle ? ` · from @${routine.fromHandle}` : ''}
                  {routine.lastRunAt ? ' · trained before' : ''}
                </Text>
                {routine.note ? (
                  <Text style={{ color: theme.textDim, fontSize: 11, marginTop: 6, lineHeight: 16 }}>
                    “{routine.note}”
                  </Text>
                ) : null}
              </View>

              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Button label="Start" tone="primary" onPress={() => start(routine.id)} gate={gate} />
                <Button label="Share" onPress={() => share(routine)} gate={gate} />
                {confirmingId === routine.id ? (
                  <Button label="Delete for good" tone="danger" onPress={() => remove(routine.id)} gate={gate} />
                ) : (
                  <Button label="Delete" onPress={() => setConfirmingId(routine.id)} gate={gate} />
                )}
              </View>
            </Animated.View>
          ))
        )}

        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={{ color: theme.textFaint, fontSize: 12, textAlign: 'center' }}>Back</Text>
        </Pressable>
      </ScrollView>

      <ShareSheet routine={sharing} onClose={() => setSharing(null)} gate={gate} />
    </View>
  );
}
