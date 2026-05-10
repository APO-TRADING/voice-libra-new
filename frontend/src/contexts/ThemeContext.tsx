// Theme + preferences context. Persisted via AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'dark' | 'light';
export type ViewMode = 'grid' | 'list';

export type ThemeColors = {
  background: string;
  surface: string;
  surface2: string;
  primary: string;
  primaryActive: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  highlight: string;
  danger: string;
};

const DARK: ThemeColors = {
  background: '#0A0A0C',
  surface: '#18181B',
  surface2: '#222226',
  primary: '#E6D5B8',
  primaryActive: '#D4AF37',
  textPrimary: '#F7F7F8',
  textSecondary: '#A1A1AA',
  border: '#27272A',
  highlight: 'rgba(212, 175, 55, 0.22)',
  danger: '#E5484D',
};

const LIGHT: ThemeColors = {
  background: '#FDFBF7',
  surface: '#FFFFFF',
  surface2: '#F5F2EB',
  primary: '#1A362D',
  primaryActive: '#0F211B',
  textPrimary: '#18181B',
  textSecondary: '#71717A',
  border: '#E4E4E7',
  highlight: 'rgba(212, 175, 55, 0.30)',
  danger: '#C0353A',
};

type Ctx = {
  mode: ThemeMode;
  colors: ThemeColors;
  toggleMode: () => void;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  defaultLengthScale: number;
  setDefaultLengthScale: (v: number) => void;
};

const ThemeContext = createContext<Ctx | undefined>(undefined);

const KEY = '@beppe.prefs.v1';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [defaultLengthScale, setDefaultLengthScale] = useState(1.0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (p.mode) setMode(p.mode);
          if (p.viewMode) setViewMode(p.viewMode);
          if (typeof p.defaultLengthScale === 'number') setDefaultLengthScale(p.defaultLengthScale);
        }
      } catch {}
      setHydrated(true);
    })();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(KEY, JSON.stringify({ mode, viewMode, defaultLengthScale })).catch(() => {});
  }, [mode, viewMode, defaultLengthScale, hydrated]);

  const value = useMemo<Ctx>(
    () => ({
      mode,
      colors: mode === 'dark' ? DARK : LIGHT,
      toggleMode: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')),
      viewMode,
      setViewMode,
      defaultLengthScale,
      setDefaultLengthScale,
    }),
    [mode, viewMode, defaultLengthScale],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider');
  return ctx;
}
