import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

describe('App smoke test', () => {
  it('renders without crashing', () => {
    render(<App />);
    // h1 title must be visible (Arabic default)
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeTruthy();
  });

  it('language toggle button is present', () => {
    render(<App />);
    const btn = screen.getByRole('button');
    expect(btn).toBeTruthy();
  });
});
