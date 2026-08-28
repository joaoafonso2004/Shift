import { useEffect } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatWeight,
  restTargetFor,
  unitLabel,
  type Settings,
  type SurfacePreference,
} from '../src/domain/settings.ts';
import { ACCENTS, ACCENT_NAMES, SURFACES, SURFACE_NAMES, resolveTheme } from '../src/domain/theme.ts';
import type { HapticGate } from '../src/motion/haptics.ts';
import { usePressScale } from '../src/motion/usePressScale.ts';
import { useSettings, useTheme } from '../src/state/settings.ts';

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View className="gap-2">
      <Text style={{ color: theme.textFaint, fontSize: 10, letterSpacing: 1.2 }}>
        {title.toUpperCase()}
      </Text>
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          padding: 14,
          gap: 14,
        }}
      >
        {children}
      </View>
      {hint ? (
        <Text style={{ color: theme.textFaint, fontSize: 10, lineHeight: 14 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function Row({ label, detail, children }: { label: string; detail?: string; children?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View className="flex-row items-center justify-between gap-3">
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>{label}</Text>
        {detail ? (
          <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2 }}>{detail}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Chip({
  label,
  active,
  colour,
  onPress,
  gate,
}: {
  label: string;
  active: boolean;
  colour?: string;
  onPress: () => void;
  gate: HapticGate;
}) {
  const theme = useTheme();
  const { gesture, style } = usePressScale({ onPress, gate });
  const tint = colour ?? theme.accent;
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: active ? tint : theme.line,
            backgroundColor: active ? `${tint}22` : theme.surfaceAlt,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          },
          style,
        ]}
      >
        {colour ? (
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colour }} />
        ) : null}
        <Text style={{ color: active ? tint : theme.textDim, fontSize: 12, fontWeight: '700' }}>
          {label}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

function Stepper({
  value,
  onChange,
  step,
  min,
  max,
  format,
  gate,
}: {
  value: number;
  onChange: (next: number) => void;
  step: number;
  min: number;
  max: number;
  format: (v: number) => string;
  gate: HapticGate;
}) {
  const theme = useTheme();
  const dec = usePressScale({ onPress: () => onChange(Math.max(min, value - step)), gate });
  const inc = usePressScale({ onPress: () => onChange(Math.min(max, value + step)), gate });

  const button = (sign: string, handle: ReturnType<typeof usePressScale>) => (
    <GestureDetector gesture={handle.gesture}>
      <Animated.View
        style={[
          {
            width: 34,
            height: 34,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.surfaceAlt,
            borderWidth: 1,
            borderColor: theme.line,
          },
          handle.style,
        ]}
      >
        <Text style={{ color: theme.textDim, fontSize: 17, fontWeight: '800' }}>{sign}</Text>
      </Animated.View>
    </GestureDetector>
  );

  return (
    <View className="flex-row items-center gap-2">
      {button('−', dec)}
      <Text
        style={{
          color: theme.text,
          fontSize: 14,
          fontWeight: '700',
          minWidth: 64,
          textAlign: 'center',
          fontVariant: ['tabular-nums'],
        }}
      >
        {format(value)}
      </Text>
      {button('+', inc)}
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const settings = useSettings((s) => s.settings);
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const update = useSettings((s) => s.update);
  const setUnitSystem = useSettings((s) => s.setUnitSystem);

  const lastAt = useSharedValue(0);
  const lastPriority = useSharedValue(0);
  // Typed as a plain number: the shared value is written from the settings, and
  // narrowing it to the 0..3 union makes it incompatible with HapticGate.
  const intensity = useSharedValue<number>(settings.hapticIntensity);
  const gate: HapticGate = { lastAt, lastPriority, intensity };
  intensity.value = settings.hapticIntensity;

  useEffect(() => {
    if (!loaded) load();
  }, [load, loaded]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => update({ [key]: value } as Partial<Settings>);
  const unit = unitLabel(settings.unitSystem);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 20, paddingTop: insets.top + 20, paddingBottom: 60, gap: 22 }}
    >
      <View>
        <Text style={{ color: theme.text, fontSize: 34, fontWeight: '800' }}>Settings</Text>
        <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 4 }}>
          Everything here changes how Shift behaves, not just how it looks.
        </Text>
      </View>

      <Section
        title="Appearance"
        hint="Every surface and accent pairing is checked against WCAG AA contrast, so nothing here can make the app unreadable."
      >
        <View className="gap-2">
          <Text style={{ color: theme.textDim, fontSize: 12 }}>Surface</Text>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="System"
              active={settings.surface === 'system'}
              onPress={() => set('surface', 'system' as SurfacePreference)}
              gate={gate}
            />
            {SURFACE_NAMES.map((name) => (
              <Chip
                key={name}
                label={SURFACES[name].label}
                active={settings.surface === name}
                onPress={() => set('surface', name)}
                gate={gate}
              />
            ))}
          </View>
        </View>

        <View className="gap-2">
          <Text style={{ color: theme.textDim, fontSize: 12 }}>Accent</Text>
          <View className="flex-row flex-wrap gap-2">
            {ACCENT_NAMES.map((name) => (
              <Chip
                key={name}
                label={ACCENTS[name].label}
                colour={resolveTheme(theme.name, name).accent}
                active={settings.accent === name}
                onPress={() => set('accent', name)}
                gate={gate}
              />
            ))}
          </View>
        </View>

        <Row label="Reduce motion" detail="Shorter, flatter animations. The OS setting still wins.">
          <Switch
            value={settings.reduceMotion}
            onValueChange={(v) => set('reduceMotion', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>

        <View className="gap-2">
          <Text style={{ color: theme.textDim, fontSize: 12 }}>Haptics</Text>
          <View className="flex-row flex-wrap gap-2">
            {(['Off', 'Light', 'Standard', 'Intense'] as const).map((label, i) => (
              <Chip
                key={label}
                label={label}
                active={settings.hapticIntensity === i}
                onPress={() => set('hapticIntensity', i as 0 | 1 | 2 | 3)}
                gate={gate}
              />
            ))}
          </View>
        </View>
      </Section>

      <Section
        title="Units and equipment"
        hint="Switching units swaps the bar and the plates, not just the label — a US gym has 45lb plates, so the loads Shift proposes have to change with it."
      >
        <View className="gap-2">
          <Text style={{ color: theme.textDim, fontSize: 12 }}>Units</Text>
          <View className="flex-row gap-2">
            <Chip label="kg" active={settings.unitSystem === 'metric'} onPress={() => setUnitSystem('metric')} gate={gate} />
            <Chip label="lb" active={settings.unitSystem === 'imperial'} onPress={() => setUnitSystem('imperial')} gate={gate} />
          </View>
        </View>

        <Row label="Bar weight" detail={`Women's bars are 15kg; a trap bar can be 25kg.`}>
          <Stepper
            value={settings.barWeightKg}
            onChange={(v) => set('barWeightKg', v)}
            step={2.5}
            min={5}
            max={40}
            format={(v) => `${formatWeight(v, settings.unitSystem)} ${unit}`}
            gate={gate}
          />
        </Row>

        <Row label="Dumbbell step" detail="The gap between racked dumbbells.">
          <Stepper
            value={settings.dumbbellStepKg}
            onChange={(v) => set('dumbbellStepKg', v)}
            step={0.5}
            min={0.5}
            max={5}
            format={(v) => `${formatWeight(v, settings.unitSystem)} ${unit}`}
            gate={gate}
          />
        </Row>

        <Row label="Machine step" detail="One plate on a selectorised stack.">
          <Stepper
            value={settings.machineStepKg}
            onChange={(v) => set('machineStepKg', v)}
            step={1}
            min={1}
            max={15}
            format={(v) => `${formatWeight(v, settings.unitSystem)} ${unit}`}
            gate={gate}
          />
        </Row>
      </Section>

      <Section
        title="Rest"
        hint="Compounds and isolations get separate timers. Three minutes after squats and three minutes after lateral raises is not the same session."
      >
        <Row label="After compounds" detail="Squats, presses, rows, deadlifts.">
          <Stepper
            value={settings.restCompoundS}
            onChange={(v) => set('restCompoundS', v)}
            step={15}
            min={30}
            max={420}
            format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
            gate={gate}
          />
        </Row>
        <Row label="After isolations" detail="Curls, raises, extensions.">
          <Stepper
            value={settings.restIsolationS}
            onChange={(v) => set('restIsolationS', v)}
            step={15}
            min={15}
            max={300}
            format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
            gate={gate}
          />
        </Row>
        <Row label="Start automatically" detail="Begin the timer the moment a set is logged. Needs the rest timer screen — not built yet.">
          <Switch
            value={settings.restAutoStart}
            onValueChange={(v) => set('restAutoStart', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
        <Row label="Heads-up" detail="Warn this many seconds before rest ends.">
          <Stepper
            value={settings.restAlertS}
            onChange={(v) => set('restAlertS', v)}
            step={5}
            min={0}
            max={30}
            format={(v) => (v === 0 ? 'Off' : `${v}s`)}
            gate={gate}
          />
        </Row>
        <Row label="Keep screen on" detail="During an active workout only.">
          <Switch
            value={settings.keepScreenAwake}
            onValueChange={(v) => set('keepScreenAwake', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
      </Section>

      <Section
        title="Progression"
        hint={`Shift adds weight once you hit the top of the range on every set, and backs off after ${settings.deloadAfterFailures} short sessions. Increments are per equipment — a barbell steps further than a band.`}
      >
        <Row label="Automatic progression" detail="Let Shift raise the weight for you.">
          <Switch
            value={settings.autoProgression}
            onValueChange={(v) => set('autoProgression', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
        <Row label="Rep range" detail="Work up within this, then add weight.">
          <View className="flex-row items-center gap-2">
            <Stepper
              value={settings.repRangeMin}
              onChange={(v) => set('repRangeMin', v)}
              step={1}
              min={1}
              max={settings.repRangeMax}
              format={(v) => `${v}`}
              gate={gate}
            />
            <Text style={{ color: theme.textFaint }}>–</Text>
            <Stepper
              value={settings.repRangeMax}
              onChange={(v) => set('repRangeMax', v)}
              step={1}
              min={settings.repRangeMin}
              max={30}
              format={(v) => `${v}`}
              gate={gate}
            />
          </View>
        </Row>
        <Row label="Barbell increment" detail="How much to add when you earn it.">
          <Stepper
            value={settings.incrementKg.barbell ?? 2.5}
            onChange={(v) => set('incrementKg', { ...settings.incrementKg, barbell: v })}
            step={1.25}
            min={1.25}
            max={10}
            format={(v) => `${formatWeight(v, settings.unitSystem)} ${unit}`}
            gate={gate}
          />
        </Row>
        <Row label="Deload after" detail="Short sessions in a row before backing off.">
          <Stepper
            value={settings.deloadAfterFailures}
            onChange={(v) => set('deloadAfterFailures', v)}
            step={1}
            min={1}
            max={5}
            format={(v) => `${v}`}
            gate={gate}
          />
        </Row>
        <Row label="Warm-up sets" detail={`${settings.warmupPercents.join('%, ')}% of the working weight.`}>
          <Switch
            value={settings.warmupEnabled}
            onValueChange={(v) => set('warmupEnabled', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
        <Row label="Track RPE" detail="Log how hard each set felt. Needs the RPE control on a set row — not built yet.">
          <Switch
            value={settings.trackRpe}
            onValueChange={(v) => set('trackRpe', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
      </Section>

      <Section
        title="Squad"
        hint="The rail shows how hard someone is working relative to their own best, not what is on their bar. Four people of different bodyweights comparing kilos turns training into a leaderboard."
      >
        <Row label="Show absolute weights" detail="Off by default, and it is off for a reason.">
          <Switch
            value={settings.showAbsoluteLoads}
            onValueChange={(v) => set('showAbsoluteLoads', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
        <Row label="Squad haptics" detail="Your turn, your rest, and one pulse per round.">
          <Switch
            value={settings.squadHaptics}
            onValueChange={(v) => set('squadHaptics', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
      </Section>

      <Section title="Data">
        <View className="gap-2">
          <Text style={{ color: theme.textDim, fontSize: 12 }}>Week starts on</Text>
          <View className="flex-row gap-2">
            {(['monday', 'sunday', 'saturday'] as const).map((day) => (
              <Chip
                key={day}
                label={day[0]!.toUpperCase() + day.slice(1, 3)}
                active={settings.weekStartsOn === day}
                onPress={() => set('weekStartsOn', day)}
                gate={gate}
              />
            ))}
          </View>
        </View>
        <Row label="Sync on cellular" detail="Otherwise Shift waits for Wi-Fi.">
          <Switch
            value={settings.syncOnCellular}
            onValueChange={(v) => set('syncOnCellular', v)}
            trackColor={{ true: theme.accent, false: theme.line }}
          />
        </Row>
      </Section>

      <Text style={{ color: theme.textFaint, fontSize: 10, lineHeight: 15 }}>
        Rest right now: {Math.round(restTargetFor(settings, true) / 60)} min after compounds,{' '}
        {restTargetFor(settings, false)}s after isolations.
      </Text>
    </ScrollView>
  );
}
