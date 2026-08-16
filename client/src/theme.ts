import { createTheme, rem } from '@mantine/core';

export const eqfalTheme = createTheme({
  primaryColor: 'eqfal',
  primaryShade: 7,
  colors: {
    eqfal: ['#f2f6fa', '#e4ebf3', '#c4d2e2', '#a1b7cf', '#7194b8', '#49769f', '#2f5b85', '#17375e', '#112d50', '#0a2443'],
  },
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'sm',
  radius: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  spacing: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  shadows: {
    xs: '0 1px 2px rgba(23, 55, 94, 0.04)',
    sm: '0 4px 14px rgba(23, 55, 94, 0.06)',
    md: '0 8px 24px rgba(23, 55, 94, 0.08)',
  },
  other: { background: '#f4f7fa', surface: '#ffffff', text: '#17243a', success: '#16724a', warning: '#9a6500', danger: '#ad2e2e' },
});
