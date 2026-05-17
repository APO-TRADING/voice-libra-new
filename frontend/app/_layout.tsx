// PATCH (beppe-audiobooks v6.2): URL/URLSearchParams polyfill MUST be the
// very first thing the bundle evaluates. Hermes (Expo Go's JS engine) does
// not always expose a complete URLSearchParams API — and pdfjs-dist 3.x
// touches `URLSearchParams.prototype` at module-load time, which crashes
// the require() if the global is missing. The auto-import below installs a
// full WHATWG-compliant URL + URLSearchParams BEFORE any other module is
// loaded.
import 'react-native-url-polyfill/auto';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// Importing piperEngine at the ROOT layout triggers its module-level
// bootstrap (global error handler + ==SESSION.START== trace line) BEFORE
// any other screen mounts. This way the persistent trace captures every
// app launch even if the user never reaches Settings.
import { tracePiper } from '../src/audio/piperEngine';
import { ThemeProvider, useTheme } from '../src/contexts/ThemeContext';
import { PlayerProvider } from '../src/contexts/PlayerContext';
import { I18nProvider, useT } from '../src/i18n';

function StackInner() {
  const { mode, colors } = useTheme();
  const t = useT();
  useEffect(() => {
    tracePiper('app.stackMounted', `theme=${mode}`);
  }, [mode]);
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.textPrimary,
          contentStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="player/[id]" options={{ title: t('common.play'), presentation: 'card' }} />
        <Stack.Screen name="folders/[id]" options={{ headerShown: false, presentation: 'card' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    tracePiper('app.rootMounted', 'GestureHandlerRoot + SafeArea ready');
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider>
          <ThemeProvider>
            <PlayerProvider>
              <StackInner />
            </PlayerProvider>
          </ThemeProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
