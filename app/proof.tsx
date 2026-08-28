import { useEffect, useMemo, useState } from 'react';
import { Text, View, ScrollView } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BUCKET_LABELS } from '../src/motion/frameStats.ts';
import { LiveNumber } from '../src/motion/LiveNumber.tsx';
import { springs } from '../src/motion/springs.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useFrameSentinel } from '../src/motion/useFrameSentinel.ts';

const LOAD_STEPS = [0, 60, 180, 400] as const;

const VERDICT_COLOR = {
  unknown: '#5b6270',
  pass: '#3ddc97',
  capped: '#ffb020',
  dropping: '#ff5f56',
} as const;

/**
 * One animated node in the stress field.
 *
 * Every node reads the same shared `progress` value and derives its own phase
 * from a constant index. Nothing is passed down that changes, so this component
 * renders once and then never again no matter how long the animation runs — the
 * motion happens entirely on the UI thread.
 */
function Node({ index, progress }: { index: number; progress: SharedValue<number> }) {
  const phase = (index % 40) / 40;
  const row = Math.floor(index / 20);

  const style = useAnimatedStyle(() => {
    const t = (progress.value + phase) % 1;
    return {
      transform: [
        { translateX: interpolate(t, [0, 0.5, 1], [0, 26, 0]) },
        { translateY: interpolate(t, [0, 0.5, 1], [0, -14, 0]) },
        { scale: interpolate(t, [0, 0.5, 1], [0.7, 1.15, 0.7]) },
        { rotate: `${interpolate(t, [0, 1], [0, 360])}deg` },
      ],
      opacity: interpolate(t, [0, 0.5, 1], [0.35, 1, 0.35]),
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 8 + (index % 20) * 17,
          top: 8 + (row % 20) * 15,
          width: 9,
          height: 9,
          borderRadius: 3,
          backgroundColor: index % 3 === 0 ? '#4f8cff' : index % 3 === 1 ? '#3ddc97' : '#c77dff',
        },
        style,
      ]}
    />
  );
}

/** A card the user can throw around, to prove gestures stay smooth under load. */
function DragCard() {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const held = useSharedValue(0);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          'worklet';
          held.value = withSpring(1, springs.press);
        })
        .onChange((e) => {
          'worklet';
          // 1:1 with the finger. No state, no runOnJS, nothing per frame.
          x.value += e.changeX;
          y.value += e.changeY;
        })
        .onFinalize((e) => {
          'worklet';
          held.value = withSpring(0, springs.release);
          // Seeding the release with gesture velocity is what makes motion read
          // as continuous rather than as two separate events.
          x.value = withSpring(0, { ...springs.release, velocity: e.velocityX });
          y.value = withSpring(0, { ...springs.release, velocity: e.velocityY });
        }),
    [held, x, y],
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: 1 + held.value * 0.06 },
      { rotateZ: `${x.value * 0.03}deg` },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            height: 84,
            borderRadius: 20,
            backgroundColor: '#12141a',
            borderWidth: 1,
            borderColor: '#1e2129',
            alignItems: 'center',
            justifyContent: 'center',
          },
          style,
        ]}
      >
        <Text className="text-chalk-dim text-sm">drag me — hard</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function Button({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  const { gesture, style } = usePressScale({ onPress });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: active ? '#4f8cff' : '#1e2129',
            backgroundColor: active ? 'rgba(79,140,255,0.14)' : '#12141a',
          },
          style,
        ]}
      >
        <Text style={{ color: active ? '#4f8cff' : '#9aa1ae', fontSize: 13, fontWeight: '600' }}>
          {label}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

export default function ProofScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState(0);
  const { stats, reset, live } = useFrameSentinel();

  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 2400 }), -1, false);
  }, [progress]);

  const nodes = useMemo(
    () => Array.from({ length: LOAD_STEPS[load] ?? 0 }, (_, i) => i),
    [load],
  );

  const maxBucket = Math.max(1, ...stats.histogram);

  return (
    <ScrollView
      className="flex-1 bg-ink"
      contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16, gap: 18 }}
    >
      <View>
        <Text className="text-chalk text-3xl font-bold">Shift · frame sentinel</Text>
        <Text className="text-chalk-faint text-xs mt-1">
          Measured on the UI thread. Run on a physical ProMotion device — the simulator reports its
          host display and means nothing.
        </Text>
      </View>

      {/* Verdict. Re-renders twice a second, never per frame. */}
      <View
        className="rounded-2xl p-4 border"
        style={{ borderColor: VERDICT_COLOR[stats.verdict], backgroundColor: '#12141a' }}
      >
        <Text
          style={{ color: VERDICT_COLOR[stats.verdict], fontSize: 13, fontWeight: '700', letterSpacing: 1 }}
        >
          {stats.verdict.toUpperCase()}
        </Text>
        <Text className="text-chalk text-sm mt-2 leading-5">{stats.headline}</Text>
      </View>

      {/* Live counters, driven straight from shared values at zero React renders. */}
      <View className="flex-row gap-3">
        <View className="flex-1 rounded-2xl bg-ink-soft border border-ink-line p-3">
          <Text className="text-chalk-faint text-[10px] uppercase tracking-wider">Live FPS</Text>
          <LiveNumber
            value={live.frames}
            format={(frames) => {
              'worklet';
              return frames > 0 ? String(Math.round(frames)) : '—';
            }}
            style={{ color: '#f4f5f7', fontSize: 28, fontWeight: '700', padding: 0 }}
          />
          <Text className="text-chalk-faint text-[10px]">frames sampled</Text>
        </View>
        <View className="flex-1 rounded-2xl bg-ink-soft border border-ink-line p-3">
          <Text className="text-chalk-faint text-[10px] uppercase tracking-wider">Interval</Text>
          <Text className="text-chalk text-[28px] font-bold">{stats.meanDeltaMs.toFixed(2)}</Text>
          <Text className="text-chalk-faint text-[10px]">
            ms mean · budget {stats.budgetMs?.toFixed(2) ?? '—'}
          </Text>
        </View>
      </View>

      <View className="flex-row gap-3">
        <Stat label="Refresh" value={stats.inferredHz ? `${stats.inferredHz}Hz` : '—'} />
        <Stat label="Hitches" value={`${stats.hitches}`} sub={`${(stats.hitchRate * 100).toFixed(2)}%`} />
        <Stat label="Worst" value={`${stats.worstDeltaMs.toFixed(1)}`} sub="ms" />
      </View>

      {/* Histogram: the actual evidence. A tall bar in the 120Hz row is the proof. */}
      <View className="rounded-2xl bg-ink-soft border border-ink-line p-4 gap-2">
        <Text className="text-chalk-faint text-[10px] uppercase tracking-wider mb-1">
          Frame interval distribution
        </Text>
        {BUCKET_LABELS.map((label, i) => {
          const count = stats.histogram[i] ?? 0;
          const isTarget = i === 1;
          return (
            <View key={label} className="flex-row items-center gap-2">
              <Text className="text-chalk-faint text-[10px] w-28">{label}</Text>
              <View className="flex-1 h-2 rounded-full bg-ink overflow-hidden">
                <View
                  style={{
                    width: `${(count / maxBucket) * 100}%`,
                    height: '100%',
                    backgroundColor: isTarget ? '#3ddc97' : i > 3 ? '#ff5f56' : '#4f8cff',
                  }}
                />
              </View>
              <Text className="text-chalk-faint text-[10px] w-12 text-right">{count}</Text>
            </View>
          );
        })}
      </View>

      <View className="gap-2">
        <Text className="text-chalk-faint text-[10px] uppercase tracking-wider">
          Animated nodes on the UI thread
        </Text>
        <View className="flex-row gap-2 flex-wrap">
          {LOAD_STEPS.map((n, i) => (
            <Button key={n} label={`${n}`} active={load === i} onPress={() => setLoad(i)} />
          ))}
          <Button label="reset stats" onPress={reset} />
        </View>
      </View>

      <View
        className="rounded-2xl bg-ink-soft border border-ink-line overflow-hidden"
        style={{ height: 320 }}
      >
        {nodes.map((i) => (
          <Node key={i} index={i} progress={progress} />
        ))}
      </View>

      <DragCard />

      <Text className="text-chalk-faint text-[11px] leading-4 mb-8">
        Raise the node count until the verdict changes. Every node is one more `useAnimatedStyle`
        recomputed per frame on the UI thread; React renders exactly once per load change. If the
        verdict reads CAPPED at any load, that is configuration, not performance — rebuild the dev
        client rather than optimising.
      </Text>
    </ScrollView>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View className="flex-1 rounded-2xl bg-ink-soft border border-ink-line p-3">
      <Text className="text-chalk-faint text-[10px] uppercase tracking-wider">{label}</Text>
      <Text className="text-chalk text-lg font-bold">{value}</Text>
      {sub ? <Text className="text-chalk-faint text-[10px]">{sub}</Text> : null}
    </View>
  );
}
