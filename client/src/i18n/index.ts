import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar';
import en from './locales/en';

/** localStorage key used to persist the user's language choice. */
export const LANG_KEY = 'eqfal-lang';

const SUPPORTED = ['ar', 'en'] as const;
type Lang = (typeof SUPPORTED)[number];

/**
 * Read the persisted language from localStorage.
 * Falls back to 'ar' when nothing is saved or localStorage is unavailable.
 * Exported for unit-testing the detection logic in isolation.
 */
export function getSavedLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    // localStorage unavailable (SSR, private mode hardening, etc.)
  }
  return 'ar';
}

i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
    en: { translation: en },
  },
  lng: getSavedLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// Persist every language change automatically — no caller discipline required.
i18n.on('languageChanged', (lng: string) => {
  try {
    localStorage.setItem(LANG_KEY, lng);
  } catch {
    // ignore
  }
});

export default i18n;
