import { createTheme, rem } from '@mantine/core';

export const eqfalTheme = createTheme({
  primaryColor: 'eqfal',
  primaryShade: 6,
  colors: {
    eqfal: ['#e6fff9', '#c6f8ed', '#8cebd8', '#4bdcc1', '#1bc9a8', '#08bf9d', '#00b894', '#00977a', '#007962', '#005f4d'],
  },
  fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'md',
  radius: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  spacing: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  shadows: {
    xs: '0 1px 2px rgba(11, 29, 51, 0.04)',
    sm: '0 4px 14px rgba(11, 29, 51, 0.06)',
    md: '0 8px 24px rgba(11, 29, 51, 0.08)',
  },
  other: {
    brand: { navy: '#0B1D33', teal: '#00B894', gold: '#D4AF37', lightGray: '#E6E9ED', mistWhite: '#F7F8FA', white: '#FFFFFF' },
    background: '#F7F8FA', surface: '#FFFFFF', text: '#0B1D33', success: '#16724a', warning: '#9a6500', danger: '#ad2e2e',
  },
});
