/**
 * i18n tests:
 *  · Arabic sets dir=rtl on <html>
 *  · English sets dir=ltr on <html>
 *  · Language change is persisted to localStorage automatically
 *  · getSavedLang() reads from localStorage on subsequent calls
 *  · getSavedLang() falls back to 'ar' when nothing is stored
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { DirectionProvider, useDirection } from '@mantine/core';
import i18n, { getSavedLang, LANG_KEY } from '../i18n';
import { MantineDirectionSync } from '../App';

// ── helper: minimal component that mirrors App's dir/lang effect ─────────────

function DirMirror() {
  const { i18n: inst } = useTranslation();
  const isRtl = inst.language === 'ar';

  useEffect(() => {
    document.documentElement.dir  = isRtl ? 'rtl' : 'ltr';
    document.documentElement.lang = inst.language;
  }, [inst.language, isRtl]);

  return null;
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Reset to Arabic before each test so tests are independent.
  await act(async () => { await i18n.changeLanguage('ar'); });
  localStorage.removeItem(LANG_KEY);
});

afterEach(() => {
  localStorage.removeItem(LANG_KEY);
});

// ── RTL / LTR ────────────────────────────────────────────────────────────────

describe('i18n — RTL/LTR direction', () => {
  it('updates Mantine direction when the language changes at runtime', async () => {
    function MantineDirectionProbe() {
      const { dir } = useDirection();
      return <output data-testid="mantine-direction">{dir}</output>;
    }

    const view = render(
      <DirectionProvider initialDirection="rtl">
        <MantineDirectionSync />
        <MantineDirectionProbe />
      </DirectionProvider>,
    );

    expect(view.getByTestId('mantine-direction')).toHaveTextContent('rtl');
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(view.getByTestId('mantine-direction')).toHaveTextContent('ltr');
  });

  it('Arabic language sets dir="rtl" on <html>', async () => {
    render(<DirMirror />);

    await act(async () => { await i18n.changeLanguage('ar'); });

    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('English language sets dir="ltr" on <html>', async () => {
    render(<DirMirror />);

    await act(async () => { await i18n.changeLanguage('en'); });

    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('switching from Arabic to English updates dir to "ltr"', async () => {
    render(<DirMirror />);

    // Start Arabic
    await act(async () => { await i18n.changeLanguage('ar'); });
    expect(document.documentElement.dir).toBe('rtl');

    // Switch to English
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(document.documentElement.dir).toBe('ltr');
  });
});

// ── localStorage persistence ─────────────────────────────────────────────────

describe('i18n — language persistence', () => {
  it('changing language saves it to localStorage under LANG_KEY', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
  });

  it('changing back to Arabic saves "ar" to localStorage', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    await act(async () => { await i18n.changeLanguage('ar'); });
    expect(localStorage.getItem(LANG_KEY)).toBe('ar');
  });

  it('getSavedLang() returns stored language after it is saved', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    // getSavedLang reads localStorage — should see 'en' now saved by the listener
    expect(getSavedLang()).toBe('en');
  });

  it('getSavedLang() falls back to "ar" when nothing is in localStorage', () => {
    localStorage.removeItem(LANG_KEY);
    expect(getSavedLang()).toBe('ar');
  });

  it('getSavedLang() ignores unknown values and falls back to "ar"', () => {
    localStorage.setItem(LANG_KEY, 'fr');
    expect(getSavedLang()).toBe('ar');
    localStorage.removeItem(LANG_KEY);
  });

  it('getSavedLang() reads "en" from localStorage without i18n being involved', () => {
    localStorage.setItem(LANG_KEY, 'en');
    expect(getSavedLang()).toBe('en');
  });
});
