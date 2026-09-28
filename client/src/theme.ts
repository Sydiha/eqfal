import { createTheme, rem } from '@mantine/core';

export const eqfalTheme = createTheme({
  primaryColor: 'eqfal',
  primaryShade: 6,
  colors: {
    eqfal: ['#e8f8f4', '#d0f1e9', '#a8e4d6', '#7bd6c2', '#4bc7ad', '#22bd9e', '#00B894', '#009f80', '#00836a', '#006b57'],
  },
  fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'sm',
  radius: { xs: rem(4), sm: rem(6), md: rem(8), lg: rem(12), xl: rem(16) },
  spacing: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  shadows: {
    xs: '0 1px 2px rgba(11, 29, 51, 0.04)',
    sm: '0 4px 14px rgba(11, 29, 51, 0.06)',
    md: '0 8px 24px rgba(11, 29, 51, 0.08)',
  },
  other: {
    brand: { navy: '#0B1D33', teal: '#00B894', gold: '#D4AF37', lightGray: '#E4E8EC', mistWhite: '#FAFCFD', white: '#FFFFFF' },
    background: '#FAFCFD', surface: '#FFFFFF', text: '#1E293B', muted: '#94A3B8', success: '#16724a', warning: '#9a6500', danger: '#ad2e2e',
  },
});
