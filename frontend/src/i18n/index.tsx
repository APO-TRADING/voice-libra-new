// I18n context: language detection, persistence, and t() helper.
//
// Auto-detection: on first launch, picks the system language if among the
// supported set; otherwise falls back to italian (the app was authored in
// italian).
// User override: a setting in the Settings screen lets users force any of
// IT / EN / ES / DE / FR. The choice is persisted in AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { it, type TranslationKey, type TranslationDict } from './locales/it';
import { en } from './locales/en';
import { es } from './locales/es';
import { de } from './locales/de';
import { fr } from './locales/fr';

export type SupportedLocale = 'it' | 'en' | 'es' | 'de' | 'fr';

export const SUPPORTED_LOCALES: ReadonlyArray<{
  code: SupportedLocale;
  label: string;
  flag: string;
  sigla: string;
}> = [
  { code: 'it', label: 'Italiano',  flag: '🇮🇹', sigla: 'IT' },
  { code: 'en', label: 'English',   flag: '🇬🇧', sigla: 'EN' },
  { code: 'es', label: 'Español',   flag: '🇪🇸', sigla: 'ES' },
  { code: 'de', label: 'Deutsch',   flag: '🇩🇪', sigla: 'DE' },
  { code: 'fr', label: 'Français',  flag: '🇫🇷', sigla: 'FR' },
];

const DICTS: Record<SupportedLocale, TranslationDict> = { it, en, es, de, fr };

const STORAGE_KEY = '@beppe.locale.v1';

// Sentinel meaning "follow the system language" (re-evaluated at each launch).
const SYSTEM = 'system' as const;

function detectSystemLocale(): SupportedLocale {
  try {
    const locales = Localization.getLocales();
    for (const l of locales) {
      const code = (l.languageCode || '').toLowerCase();
      if (code === 'it' || code === 'en' || code === 'es' || code === 'de' || code === 'fr') {
        return code as SupportedLocale;
      }
    }
  } catch {
    /* ignore */
  }
  return 'it';
}

type Ctx = {
  locale: SupportedLocale;          // active resolved locale
  storedChoice: SupportedLocale | typeof SYSTEM; // 'system' or explicit
  setLocale: (locale: SupportedLocale | typeof SYSTEM) => Promise<void>;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<Ctx | undefined>(undefined);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [storedChoice, setStoredChoice] = useState<SupportedLocale | typeof SYSTEM>(SYSTEM);
  const [systemLocale] = useState<SupportedLocale>(detectSystemLocale);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw === 'it' || raw === 'en' || raw === 'es' || raw === 'de' || raw === 'fr') {
          setStoredChoice(raw);
        } else {
          setStoredChoice(SYSTEM);
        }
      } catch { /* ignore */ }
      finally { setHydrated(true); }
    })();
  }, []);

  const locale: SupportedLocale = storedChoice === SYSTEM ? systemLocale : storedChoice;

  const setLocale = useCallback(
    async (next: SupportedLocale | typeof SYSTEM) => {
      setStoredChoice(next);
      try {
        if (next === SYSTEM) await AsyncStorage.removeItem(STORAGE_KEY);
        else await AsyncStorage.setItem(STORAGE_KEY, next);
      } catch { /* ignore */ }
    },
    [],
  );

  // t() — replaces {placeholders} in the translation.
  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const dict = DICTS[locale] || it;
      const template = (dict[key] ?? it[key] ?? key) as string;
      if (!vars) return template;
      let out = template;
      for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{${k}}`).join(String(v));
      }
      return out;
    },
    [locale],
  );

  const value = useMemo<Ctx>(
    () => ({ locale, storedChoice, setLocale, t }),
    [locale, storedChoice, setLocale, t],
  );

  // Render nothing on the very first synchronous tick to avoid a flash of
  // the wrong language while AsyncStorage rehydrates. The check is cheap.
  if (!hydrated) return null;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

// Tiny helper hook so screens can just do `const t = useT();`
export function useT() {
  return useI18n().t;
}

export { SYSTEM };
