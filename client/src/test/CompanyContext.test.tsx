/**
 * CompanyContext tests:
 *  · setActiveCompany updates activeCompanyId
 *  · setActiveCompany throws for a company not in allowedCompanies
 *  · allowedCompanies is exactly what the Provider received
 *  · companyKey increments on every successful switch (signals state clear)
 *  · initialCompanyId not in allowedCompanies → falls back to first allowed
 *  · empty allowedCompanies → activeCompanyId is null
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CompanyProvider, useCompany, type Company } from '../context/CompanyContext';

// ── fixtures ─────────────────────────────────────────────────────────────────

const COMPANIES: Company[] = [
  { id: 'co-a', name: 'Company A' },
  { id: 'co-b', name: 'Company B' },
  { id: 'co-c', name: 'Company C' },
];

const UNAUTHORIZED_ID = 'co-unauthorized';

function makeWrapper(
  allowedCompanies: Company[],
  initialCompanyId?: string,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <CompanyProvider
        allowedCompanies={allowedCompanies}
        initialCompanyId={initialCompanyId}
      >
        {children}
      </CompanyProvider>
    );
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CompanyContext — active company management', () => {
  it('exposes only the allowedCompanies passed to the Provider', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    expect(result.current.allowedCompanies).toHaveLength(3);
    expect(result.current.allowedCompanies.map(c => c.id)).toEqual([
      'co-a', 'co-b', 'co-c',
    ]);
  });

  it('defaults activeCompanyId to the first allowed company', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    expect(result.current.activeCompanyId).toBe('co-a');
    expect(result.current.activeCompany?.name).toBe('Company A');
  });

  it('respects a valid initialCompanyId', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES, 'co-b'),
    });

    expect(result.current.activeCompanyId).toBe('co-b');
  });

  it('falls back to first allowed company when initialCompanyId is not allowed', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES, UNAUTHORIZED_ID),
    });

    // UNAUTHORIZED_ID is not in COMPANIES — must fall back, not silently break
    expect(result.current.activeCompanyId).toBe('co-a');
  });

  it('setActiveCompany updates activeCompanyId to the new company', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    act(() => { result.current.setActiveCompany('co-b'); });

    expect(result.current.activeCompanyId).toBe('co-b');
    expect(result.current.activeCompany?.name).toBe('Company B');
  });

  it('setActiveCompany throws when company id is not in allowedCompanies', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    expect(() => {
      act(() => { result.current.setActiveCompany(UNAUTHORIZED_ID); });
    }).toThrow(/not in the list of allowed companies/i);
  });

  it('activeCompanyId remains unchanged after a rejected setActiveCompany call', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    try {
      act(() => { result.current.setActiveCompany(UNAUTHORIZED_ID); });
    } catch {
      // expected — the call throws; we only check the state
    }

    expect(result.current.activeCompanyId).toBe('co-a');
  });

  it('companyKey increments on each successful company switch', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    const initial = result.current.companyKey;

    act(() => { result.current.setActiveCompany('co-b'); });
    expect(result.current.companyKey).toBe(initial + 1);

    act(() => { result.current.setActiveCompany('co-c'); });
    expect(result.current.companyKey).toBe(initial + 2);
  });

  it('companyKey does NOT increment when setActiveCompany throws (unauthorized)', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES),
    });

    const initial = result.current.companyKey;

    try {
      act(() => { result.current.setActiveCompany(UNAUTHORIZED_ID); });
    } catch {
      // expected
    }

    expect(result.current.companyKey).toBe(initial);
  });

  it('activeCompanyId is null when allowedCompanies is empty', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper([]),
    });

    expect(result.current.activeCompanyId).toBeNull();
    expect(result.current.activeCompany).toBeNull();
    expect(result.current.allowedCompanies).toHaveLength(0);
  });

  it('useCompany throws when called outside a CompanyProvider', () => {
    // renderHook without a wrapper — no Provider in the tree
    expect(() => {
      renderHook(() => useCompany());
    }).toThrow(/CompanyProvider/i);
  });
});
