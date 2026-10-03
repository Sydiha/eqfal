import { createTheme, rem } from '@mantine/core';

export const eqfalTheme = createTheme({
  primaryColor: 'eqfal',
  primaryShade: 6,
  colors: {
    eqfal: ['#e8f5f2', '#d4ebe6', '#a8ddd3', '#7dcfc1', '#52c1ae', '#27b39c', '#0e8f7a', '#0d7a68', '#0b6556', '#095044'],
  },
  fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Tajawal, Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'sm',
  radius: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(18), xl: rem(24) },
  spacing: { xs: rem(4), sm: rem(8), md: rem(12), lg: rem(16), xl: rem(24) },
  shadows: {
    xs: '0 1px 2px rgba(11, 29, 58, 0.04)',
    sm: '0 4px 14px rgba(11, 29, 58, 0.06)',
    md: '0 8px 24px rgba(11, 29, 58, 0.08)',
  },
  other: {
    brand: { navy: '#0B1D3A', teal: '#0E8F7A', gold: '#C8A66A', lightGray: '#E3E8EE', mistWhite: '#F5F7F9', white: '#FFFFFF' },
    background: '#F5F7F9', surface: '#FFFFFF', text: '#0B1D3A', muted: '#5B6878', success: '#1E7F4F', warning: '#8F5200', danger: '#B42318', info: '#1D5FA8',
  },
});
