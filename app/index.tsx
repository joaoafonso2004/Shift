import { Link } from 'expo-router';
import { Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePressScale } from '../src/motion/usePressScale.ts';

function PressableCard({ title, subtitle, onPress }: {
  title: string;
  subtitle: string;
  onPress?: () => void;
}) {
  const { gesture, style } = usePressScale({ ...(onPress ? { onPress } : {}) });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          {
            padding: 18,
            borderRadius: 20,
            backgroundColor: '#12141a',
            borderWidth: 1,
            borderColor: '#1e2129',
          },
          style,
        ]}
      >
        <Text className="text-chalk text-lg font-semibold">{title}</Text>
        <Text className="text-chalk-dim text-xs mt-1">{subtitle}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

export default function Home() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-ink px-5 gap-4" style={{ paddingTop: insets.top + 32 }}>
      <View>
        <Text className="text-chalk text-4xl font-bold tracking-tight">Shift</Text>
        <Text className="text-chalk-faint text-sm mt-1">
          Motion is the product. Everything else is bookkeeping.
        </Text>
      </View>

      <Link href="/workout" asChild>
        <PressableCard
          title="Today's workout"
          subtitle="Predicted numbers, one tap per set, no keyboard"
        />
      </Link>

      <Link href="/routines" asChild>
        <PressableCard
          title="Routines"
          subtitle="Yours, and the ones friends sent you — their plan, your loads"
        />
      </Link>

      <Link href="/squad" asChild>
        <PressableCard
          title="Squad"
          subtitle="Train together — two to four, one join code"
        />
      </Link>

      <Link href="/friends" asChild>
        <PressableCard
          title="Friends"
          subtitle="Consistency and streaks — never what's on the bar"
        />
      </Link>

      <Link href="/settings" asChild>
        <PressableCard
          title="Settings"
          subtitle="Theme, units, rest, progression — all of it changes behaviour"
        />
      </Link>

      <Link href="/proof" asChild>
        <PressableCard
          title="Frame sentinel"
          subtitle="Prove 120Hz is live, then stress it until it isn't"
        />
      </Link>
    </View>
  );
}
