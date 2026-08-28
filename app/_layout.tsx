import '../global.css';

import { useEffect } from 'react';
import { Stack, router, useRootNavigationState } from 'expo-router';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useInbound } from '../src/state/inbound.ts';

/**
 * Everything that arrives from outside the app: a scanned squad QR, a routine
 * link pasted into a chat, a cold start from either.
 *
 * `useURL` covers both the launch URL and links delivered while the app is
 * already running, which are two different callbacks in bare React Native and
 * the usual source of a link that works only when the app was already open.
 *
 * The navigation-state guard is not optional. A link that cold-starts the app
 * fires this effect before the root navigator has mounted, and pushing then is
 * silently dropped — which looks exactly like a broken link.
 */
function InboundLinks() {
  const url = Linking.useURL();
  const navigationKey = useRootNavigationState()?.key;
  const offerUrl = useInbound((s) => s.offerUrl);

  useEffect(() => {
    if (!url || !navigationKey) return;
    const target = offerUrl(url);
    if (target) router.push(target);
  }, [url, navigationKey, offerUrl]);

  return null;
}

export default function RootLayout() {
  return (
    // GestureHandlerRootView must be the true root. Nested anywhere lower and
    // gestures silently stop reaching the native handler on iOS.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <InboundLinks />
        <Stack
          screenOptions={{
            headerShown: false,
            // Native stack: push/pop is driven by UIKit rather than JS, so
            // navigation transitions cannot be stalled by the JS thread.
            animation: 'slide_from_right',
            contentStyle: { backgroundColor: '#08090c' },
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
