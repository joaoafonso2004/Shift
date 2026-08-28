import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openCatalog } from '../src/data/catalog.ts';
import { saveSessionAsRoutine } from '../src/data/routines.ts';
import { routineFromSession, type SharedRoutine } from '../src/domain/sharing.ts';
import { onDeck } from '../src/domain/coop.ts';
import { ExerciseCard } from '../src/features/workout/ExerciseCard.tsx';
import { SquadRail, SQUAD_RAIL_HEIGHT } from '../src/features/coop/SquadRail.tsx';
import { ShareSheet } from '../src/features/share/ShareSheet.tsx';
import { haptic, type HapticGate } from '../src/motion/haptics.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useSquadSlots } from '../src/motion/useSquadSlots.ts';
import { useCoop } from '../src/state/coop.ts';
import { useSettings } from '../src/state/settings.ts';
import { useWorkout } from '../src/state/workout.ts';

const KEEP_AWAKE_TAG = 'shift-workout';

/**
 * Name a session after what it actually trained.
 *
 * A routine called "Workout 14" tells its owner nothing a week later, and
 * asking for a title before someone can share is a keyboard on the one screen
 * that exists to avoid them. The catalog already knows the body part of every
 * exercise, so the session can name itself.
 */
function titleForSession(parts: readonly string[]): string {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return 'Workout';
  if (unique.length <= 2) {
    return unique.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' + ');
  }
  return 'Full body';
}

function PrimaryButton({ label, onPress, gate }: { label: string; onPress: () => void; gate: HapticGate }) {
  const { gesture, style } = usePressScale({ onPress, gate });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 14,
            borderRadius: 16,
            backgroundColor: '#4f8cff',
            alignItems: 'center',
          },
          style,
        ]}
      >
        <Text style={{ color: '#08090c', fontSize: 15, fontWeight: '800' }}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function GhostButton({ label, onPress, gate }: { label: string; onPress: () => void; gate: HapticGate }) {
  const { gesture, style } = usePressScale({ onPress, gate });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: '#1e2129',
            backgroundColor: '#12141a',
            alignItems: 'center',
            flex: 1,
          },
          style,
        ]}
      >
        <Text style={{ color: '#9aa1ae', fontSize: 13, fontWeight: '700' }}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

export default function WorkoutScreen() {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<SharedRoutine | null>(null);
  const [savedRoutineId, setSavedRoutineId] = useState<string | null>(null);

  const status = useWorkout((s) => s.status);
  const exercises = useWorkout((s) => s.exercises);
  const startRoutine = useWorkout((s) => s.startRoutine);
  const finish = useWorkout((s) => s.finish);

  const settings = useSettings((s) => s.settings);
  const loadSettings = useSettings((s) => s.load);
  const settingsLoaded = useSettings((s) => s.loaded);

  useEffect(() => {
    if (!settingsLoaded) loadSettings();
  }, [loadSettings, settingsLoaded]);

  // Nothing is more irritating mid-set than a phone that locked while the bar
  // was on your back. Tagged and scoped to the active workout, so the lock is
  // always released when the workout ends or the screen unmounts — an
  // un-released keep-awake drains the battery for the rest of the day.
  useEffect(() => {
    const wanted = settings.keepScreenAwake && status === 'active';
    if (wanted) void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    else void deactivateKeepAwake(KEEP_AWAKE_TAG);

    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [settings.keepScreenAwake, status]);

  // One shared haptic gate for the whole screen: the rate limiter is global, so
  // four rows scrubbing at once still cannot buzz more than once per 400ms.
  const lastAt = useSharedValue(0);
  const lastPriority = useSharedValue(0);
  const intensity = useSharedValue<number>(2);
  // Memoised: an object literal here is a new reference every render, and this
  // gate is an effect dependency. Without this the effect below re-runs, sets
  // store state, re-renders, and loops forever.
  const gate = useMemo<HapticGate>(
    () => ({ lastAt, lastPriority, intensity }),
    [lastAt, lastPriority, intensity],
  );
  intensity.value = settings.hapticIntensity;

  // Allocated at mount whether or not a squad ever joins, so joining one changes
  // values rather than the component tree (§4.7).
  const coopStatus = useCoop((s) => s.status);
  const slots = useSquadSlots(coopStatus === 'live');
  const setHapticSink = useCoop((s) => s.setHapticSink);

  // Selectors must return a stable reference. `s.rail()` and `s.deck()` build a
  // fresh array and object on every call, which makes useSyncExternalStore see
  // a new snapshot each time it checks — React then warns and can spin. Select
  // the raw state, derive here.
  const members = useCoop((s) => s.members);
  const selfId = useCoop((s) => s.selfId);
  const activeUserId = useCoop((s) => s.activeUserId);
  const loadedKg = useCoop((s) => s.loadedKg);

  const squad = useMemo(
    () => members.filter((m) => m.userId !== selfId).sort((a, b) => a.queuePos - b.queuePos),
    [members, selfId],
  );

  const deck = useMemo(() => {
    if (!selfId || members.length === 0) return null;
    return onDeck({
      sessionId: '',
      selfId,
      members,
      activeUserId,
      turnStartedAt: null,
      loadedKg,
      direction: 1,
    });
  }, [members, selfId, activeUserId, loadedKg]);

  useEffect(() => {
    // Realtime ingress fires haptics through the same gate as every local
    // interaction, so squad events cannot bypass the 400ms limiter.
    setHapticSink((kind) => {
      if (kind) haptic(gate, kind, Date.now());
    });
  }, [gate, setHapticSink]);

  const deckLine =
    deck && deck.turnsAway > 0
      ? `You're up in ~${deck.etaS}s${
          deck.loadFromKg !== null && deck.loadToKg !== null && deck.loadFromKg !== deck.loadToKg
            ? ` · bar ${deck.loadFromKg} → ${deck.loadToKg}`
            : ''
        }`
      : null;

  // Built on demand rather than kept in state: it is derived from the session,
  // and a copy held alongside it would be one more thing that can disagree with
  // what is on screen.
  const sessionShape = useCallback(
    (completedOnly: boolean): SharedRoutine =>
      routineFromSession({
        title: titleForSession(exercises.map((e) => e.catalog.bodyPart)),
        exercises: exercises.map((e) => ({
          exerciseId: e.exerciseId,
          name: e.catalog.name,
          // Weights are not passed. There is no field for them on the far side.
          sets: e.sets.map((set) => ({ reps: set.reps, completed: set.completed })),
        })),
        completedOnly,
      }),
    [exercises],
  );

  // Mid-workout, the plan is the honest thing to send; afterwards, what was
  // actually finished is.
  const onShare = useCallback(
    () => setSharing(sessionShape(status === 'finished')),
    [sessionShape, status],
  );

  const onSaveRoutine = useCallback(() => {
    setSavedRoutineId(saveSessionAsRoutine(sessionShape(false)));
  }, [sessionShape]);

  useEffect(() => {
    let cancelled = false;
    openCatalog()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <View className="flex-1 bg-ink items-center justify-center px-8">
        <Text className="text-fail text-sm text-center">Catalog failed to open</Text>
        <Text className="text-chalk-faint text-xs text-center mt-2">{error}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View className="flex-1 bg-ink items-center justify-center">
        <ActivityIndicator color="#4f8cff" />
        <Text className="text-chalk-faint text-xs mt-3">Opening catalog…</Text>
      </View>
    );
  }

  const totalSets = exercises.reduce((n, e) => n + e.sets.length, 0);
  const doneSets = exercises.reduce((n, e) => n + e.sets.filter((s) => s.completed).length, 0);

  return (
    <View className="flex-1 bg-ink">
      <ScrollView
        className="flex-1 bg-ink"
        contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 14, paddingBottom: 48 }}
      >
        {/* Height is reserved at every squad size, including solo. Joining a squad
            mid-workout must never reflow the card below. */}
        <SquadRail
          members={squad}
          slots={slots}
          onDeckLine={deckLine}
          visible={coopStatus === 'live' && squad.length > 0}
        />

        <View>
          <Text className="text-chalk text-3xl font-bold tracking-tight">Today</Text>
          <Text className="text-chalk-faint text-xs mt-1">
            {status === 'active'
              ? `${doneSets}/${totalSets} sets · hold and drag any number, tap ✓ to log`
              : 'Numbers are predicted from your history. You should never need the keyboard.'}
          </Text>
        </View>

        {status === 'idle' ? (
          <Animated.View entering={FadeIn} className="gap-3">
            <View className="rounded-3xl border border-ink-line bg-ink-soft p-5 gap-2">
              <Text className="text-chalk text-lg font-semibold">Starter routine</Text>
              <Text className="text-chalk-dim text-xs leading-5">
                Squat, bench, pulldown, shoulder press. Each one exercises a different branch of the
                predictor — progression, hold-and-add-a-rep, deload, and a cold start.
              </Text>
            </View>
            <PrimaryButton label="Start workout" onPress={() => startRoutine()} gate={gate} />
          </Animated.View>
        ) : null}

        {exercises.map((exercise) => (
          <ExerciseCard key={exercise.id} exercise={exercise} gate={gate} />
        ))}

        {status === 'active' ? (
          <View className="gap-3">
            <PrimaryButton label="Finish workout" onPress={finish} gate={gate} />
            <View className="flex-row gap-3">
              <GhostButton label="Share this workout" onPress={onShare} gate={gate} />
            </View>
          </View>
        ) : null}

        {status === 'finished' ? (
          <View className="gap-3">
            <View className="rounded-3xl border border-pass bg-ink-soft p-5">
              <Text className="text-pass text-sm font-bold">Logged</Text>
              <Text className="text-chalk-dim text-xs mt-1 leading-5">
                {doneSets} of {totalSets} sets, written to this device. They are already what the
                predictor reads next session; syncing happens in the background when a project is
                configured.
              </Text>
            </View>

            <View className="flex-row gap-3">
              <GhostButton label="Share it" onPress={onShare} gate={gate} />
              <GhostButton
                label={savedRoutineId ? 'Saved ✓' : 'Save as routine'}
                onPress={onSaveRoutine}
                gate={gate}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>

      <ShareSheet routine={sharing} onClose={() => setSharing(null)} gate={gate} />
    </View>
  );
}
