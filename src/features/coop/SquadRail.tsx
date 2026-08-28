import { memo, useCallback, useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from 'react-native-reanimated';

import { POD_COMPACT_W, POD_WIDE_W, podWidth, type SquadMember } from '../../domain/coop.ts';
import { LiveNumber } from '../../motion/LiveNumber.tsx';
import { springs } from '../../motion/springs.ts';
import { STATE_CODE, type SquadSlots } from '../../motion/useSquadSlots.ts';

/**
 * Reserved permanently, at every squad size including solo.
 *
 * A solo session renders the rail at zero opacity rather than not rendering it,
 * so joining a squad mid-workout can never reflow the workout card. Zero layout
 * thrash on join and leave, by construction (§6.4).
 */
export const SQUAD_RAIL_HEIGHT = 68;

const SLOT_HUE = ['#4f8cff', '#ff8a4f', '#3ddc97', '#c77dff'] as const;

interface PodProps {
  member: SquadMember;
  slots: SquadSlots;
  width: number;
}

function Pod({ member, slots, width }: PodProps) {
  const slot = member.colorSlot;
  const hue = SLOT_HUE[slot] ?? '#5b6270';

  // Every countdown on screen derives from the single `nowMs` the frame callback
  // maintains. One writer, N readers: the cost of the timers is flat in squad
  // size and nothing here polls (§2.5).
  const remaining = useDerivedValue(() => {
    const endsAt = slots.restEndsAt[slot]?.value ?? 0;
    if (endsAt === 0) return 0;
    return Math.max(0, (endsAt - slots.nowMs.value) / 1000);
  });

  const ringStyle = useAnimatedStyle(() => {
    const endsAt = slots.restEndsAt[slot]?.value ?? 0;
    const target = slots.restTargetS[slot]?.value ?? 90;
    // Computed straight from epoch milliseconds. Building a Date, formatting it
    // to ISO and parsing it back — which is what calling restProgress here would
    // do — allocates twice per pod per frame, for a value already held as a
    // number.
    const remaining = endsAt === 0 ? 0 : Math.max(0, (endsAt - slots.nowMs.value) / 1000);
    const progress = endsAt === 0 || target <= 0 ? 1 : Math.min(1, Math.max(0, 1 - remaining / target));
    return {
      transform: [{ scale: withSpring(0.85 + progress * 0.15, springs.reorder) }],
      opacity: interpolate(progress, [0, 1], [0.5, 1], Extrapolation.CLAMP),
    };
  });

  const podStyle = useAnimatedStyle(() => {
    const isActive = slots.activeSlot.value === slot;
    const isFocused = slots.focusSlot.value === slot;
    const isDropped =
      (slots.state[slot]?.value ?? 0) >= STATE_CODE.stalled ||
      (slots.state[slot]?.value ?? 0) === STATE_CODE.away;

    return {
      width: withSpring(width, springs.sheet),
      transform: [{ scale: withSpring(isFocused ? 1 : 0.96, springs.reorder) }],
      // Exactly one pod is ever emphasised; the rest recede rather than compete.
      opacity: withSpring(isDropped ? 0.3 : isFocused || isActive ? 1 : 0.6, springs.reorder),
      borderColor: isFocused ? hue : '#1e2129',
    };
  });

  // Label opacity is interpolated from the measured width rather than switched
  // at a breakpoint, so a member joining animates continuously (§6.4).
  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(width, [POD_COMPACT_W, POD_WIDE_W], [0, 1], Extrapolation.CLAMP),
  }));

  const progressStyle = useAnimatedStyle(() => ({
    width: `${(slots.progress[slot]?.value ?? 0) * 100}%`,
  }));

  return (
    <Animated.View
      style={[
        {
          height: 52,
          borderRadius: 16,
          borderWidth: 1,
          backgroundColor: '#12141a',
          paddingHorizontal: 10,
          justifyContent: 'center',
          overflow: 'hidden',
        },
        podStyle,
      ]}
    >
      <View className="flex-row items-center gap-2">
        <Animated.View
          style={[
            { width: 10, height: 10, borderRadius: 5, backgroundColor: hue },
            ringStyle,
          ]}
        />
        <Animated.View style={[{ flex: 1 }, labelStyle]}>
          <Text className="text-chalk text-[11px] font-semibold" numberOfLines={1}>
            {member.displayName}
          </Text>
          <Text className="text-chalk-faint text-[9px]">
            {/* Relative intensity, never kilos. Four friends of different
                bodyweights showing raw numbers turns training into a
                leaderboard (§6.3). */}
            {member.relativeIntensity !== null
              ? `${Math.round(member.relativeIntensity * 100)}%`
              : '—'}
          </Text>
        </Animated.View>
        <LiveNumber
          value={remaining}
          format={(s) => {
            'worklet';
            return s > 0 ? `${Math.ceil(s)}s` : '';
          }}
          style={{ color: '#9aa1ae', fontSize: 11, padding: 0, minWidth: 26, textAlign: 'right' }}
        />
      </View>

      <View
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 2,
          width: '100%',
          backgroundColor: '#1e2129',
        }}
      />
      <Animated.View
        style={[
          { position: 'absolute', left: 0, bottom: 0, height: 2, backgroundColor: hue },
          progressStyle,
        ]}
      />
    </Animated.View>
  );
}

export interface SquadRailProps {
  members: readonly SquadMember[];
  slots: SquadSlots;
  /** "You're up in ~40s · bar 100 → 80" — worth more than every other state at N=4. */
  onDeckLine: string | null;
  visible: boolean;
}

function SquadRailComponent({ members, slots, onDeckLine, visible }: SquadRailProps) {
  const [railWidth, setRailWidth] = useState(0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setRailWidth(e.nativeEvent.layout.width),
    [],
  );

  // memberCount includes you; the rail renders the others.
  const width = podWidth(railWidth, members.length + 1);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: withSpring(visible ? 1 : 0, springs.sheet),
  }));

  return (
    <Animated.View style={[{ height: SQUAD_RAIL_HEIGHT }, containerStyle]} onLayout={onLayout}>
      <View className="flex-row gap-2">
        {members.map((member) => (
          <Pod key={member.userId} member={member} slots={slots} width={width} />
        ))}
      </View>
      {onDeckLine ? (
        <Text className="text-chalk-dim text-[10px] mt-1" numberOfLines={1}>
          {onDeckLine}
        </Text>
      ) : null}
    </Animated.View>
  );
}

export const SquadRail = memo(SquadRailComponent);
