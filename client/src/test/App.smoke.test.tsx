import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
});

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe('App smoke test', () => {
  it('renders without crashing', () => {
    renderApp();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeTruthy();
  });

  it('language toggle button is present', () => {
    renderApp();
    const btn = screen.getByText(/Switch to English|التبديل إلى العربية/);
    expect(btn).toBeTruthy();
  });
});
