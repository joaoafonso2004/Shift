import { TextInput, type TextStyle } from 'react-native';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export interface LiveNumberProps {
  value: SharedValue<number>;
  /** Must be a worklet — it runs on the UI thread every frame. */
  format: (value: number) => string;
  style?: TextStyle;
}

/**
 * Text driven from the UI thread, at zero React renders.
 *
 * Reanimated has no animated `<Text>`, so the standard route is an animated
 * `TextInput` whose `text` prop is written from `useAnimatedProps`. The prop is
 * not in TextInput's public types, hence the cast — it is a real, supported
 * native prop.
 *
 * This is what lets a 90-second rest countdown, or a frame counter ticking at
 * 120Hz, update continuously without re-rendering anything.
 */
export function LiveNumber({ value, format, style }: LiveNumberProps) {
  const animatedProps = useAnimatedProps(() => {
    const text = format(value.value);
    return { text, defaultValue: text } as unknown as Record<string, unknown>;
  });

  return (
    <AnimatedTextInput
      editable={false}
      // eslint-disable-next-line react/jsx-props-no-spreading
      animatedProps={animatedProps}
      style={style}
      value={undefined}
    />
  );
}
