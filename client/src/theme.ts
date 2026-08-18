import { createTheme, rem } from '@mantine/core';

export const eqfalTheme = createTheme({
  primaryColor: 'eqfal',
  primaryShade: 6,
  colors: {
    eqfal: ['#edf9f7', '#d8f1ed', '#b6e3dc', '#8bd2c7', '#5abdab', '#2da893', '#0E8F7A', '#0a7464', '#075b4f', '#04443b'],
  },
  fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'md',
  radius: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  spacing: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  shadows: {
    xs: '0 1px 2px rgba(11, 29, 58, 0.04)',
    sm: '0 4px 14px rgba(11, 29, 58, 0.06)',
    md: '0 8px 24px rgba(11, 29, 58, 0.08)',
  },
  other: {
    brand: { navy: '#0B1D3A', teal: '#0E8F7A', gold: '#C8A66A', lightGray: '#E6ECEE', mistWhite: '#F4F6F7', white: '#FFFFFF' },
    background: '#F4F6F7', surface: '#FFFFFF', text: '#0B1D3A', success: '#16724a', warning: '#9a6500', danger: '#ad2e2e',
  },
});
