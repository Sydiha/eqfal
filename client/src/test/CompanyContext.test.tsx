/**
 * CompanyContext tests:
 *  · setActiveCompany updates activeCompanyId
 *  · setActiveCompany throws for a company not in allowedCompanies
 *  · allowedCompanies is exactly what the Provider received
 *  · companyKey increments on every successful switch (signals state clear)
 *  · initialCompanyId not in allowedCompanies → falls back to first allowed
 *  · empty allowedCompanies → activeCompanyId is null
 *  · rerender reconciliation — activeCompanyId always consistent with new list
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
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

  it('re-selecting the already-active company is a no-op: activeCompanyId unchanged', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES, 'co-b'),
    });

    expect(result.current.activeCompanyId).toBe('co-b');

    act(() => { result.current.setActiveCompany('co-b'); }); // same company

    expect(result.current.activeCompanyId).toBe('co-b');
  });

  it('re-selecting the already-active company is a no-op: companyKey unchanged', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES, 'co-b'),
    });

    const keyBefore = result.current.companyKey;

    act(() => { result.current.setActiveCompany('co-b'); }); // same company

    expect(result.current.companyKey).toBe(keyBefore);
  });

  it('switching to a different company still increments companyKey', () => {
    const { result } = renderHook(() => useCompany(), {
      wrapper: makeWrapper(COMPANIES, 'co-a'),
    });

    const keyBefore = result.current.companyKey;

    act(() => { result.current.setActiveCompany('co-b'); }); // different company

    expect(result.current.activeCompanyId).toBe('co-b');
    expect(result.current.companyKey).toBe(keyBefore + 1);
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

// ── rerender reconciliation ───────────────────────────────────────────────────
// Tests for post-mount synchronisation: when allowedCompanies changes after
// the first render, activeCompanyId must stay consistent with the new list.
//
// Pattern: a stateful Wrapper drives allowedCompanies so rerender() triggers
// an actual React prop change into CompanyProvider.

describe('CompanyContext — allowedCompanies rerender reconciliation', () => {
  it('companies arrive after empty list → picks the first allowed company', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>([]);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies}>{children}</CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    expect(result.current.activeCompanyId).toBeNull();

    await act(async () => { setCompanies(COMPANIES); });

    expect(result.current.activeCompanyId).toBe('co-a');
    expect(result.current.activeCompany?.name).toBe('Company A');
  });

  it('companies arrive after empty list → prefers initialCompanyId when allowed', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>([]);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies} initialCompanyId="co-c">
          {children}
        </CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    expect(result.current.activeCompanyId).toBeNull();

    await act(async () => { setCompanies(COMPANIES); });

    expect(result.current.activeCompanyId).toBe('co-c');
  });

  it('active company revoked → falls back to first remaining company', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>(COMPANIES);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies}>{children}</CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    // Start on co-a (first by default)
    expect(result.current.activeCompanyId).toBe('co-a');

    // Remove co-a from the list
    await act(async () => { setCompanies([COMPANIES[1], COMPANIES[2]]); });

    expect(result.current.activeCompanyId).toBe('co-b'); // next first
  });

  it('active company revoked → prefers initialCompanyId when still allowed', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>(COMPANIES);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies} initialCompanyId="co-c">
          {children}
        </CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    // Manually switch to co-b so activeCompanyId !== initialCompanyId
    await act(async () => { result.current.setActiveCompany('co-b'); });
    expect(result.current.activeCompanyId).toBe('co-b');

    // Remove co-b — co-c (initialCompanyId) is still in the list
    await act(async () => {
      setCompanies([COMPANIES[0], COMPANIES[2]]); // co-a, co-c
    });

    expect(result.current.activeCompanyId).toBe('co-c');
  });

  it('allowedCompanies becomes empty → activeCompanyId becomes null', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>(COMPANIES);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies}>{children}</CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    expect(result.current.activeCompanyId).toBe('co-a');

    await act(async () => { setCompanies([]); });

    expect(result.current.activeCompanyId).toBeNull();
    expect(result.current.activeCompany).toBeNull();
  });

  it('active company still in updated list → no change, companyKey unchanged', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>(COMPANIES);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies}>{children}</CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    await act(async () => { result.current.setActiveCompany('co-b'); });
    const keyBefore = result.current.companyKey;

    // Update list but keep co-b in it
    await act(async () => {
      setCompanies([COMPANIES[1], COMPANIES[2]]); // co-b, co-c — co-b still present
    });

    expect(result.current.activeCompanyId).toBe('co-b');
    expect(result.current.companyKey).toBe(keyBefore); // no remount
  });

  it('revocation increments companyKey (signals downstream remount)', async () => {
    let setCompanies!: (c: Company[]) => void;

    function Wrapper({ children }: { children: ReactNode }) {
      const [companies, setC] = useState<Company[]>(COMPANIES);
      setCompanies = setC;
      return (
        <CompanyProvider allowedCompanies={companies}>{children}</CompanyProvider>
      );
    }

    const { result } = renderHook(() => useCompany(), { wrapper: Wrapper });

    const keyBefore = result.current.companyKey;

    // Remove co-a (the active company) — forces a switch
    await act(async () => { setCompanies([COMPANIES[1], COMPANIES[2]]); });

    expect(result.current.companyKey).toBe(keyBefore + 1);
  });
});
