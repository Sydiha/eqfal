/**
 * CompanySwitcher tests:
 *  · Renders only the companies in the allowed list (no extras)
 *  · Does not render an option for an unauthorized company id
 *  · Selecting an option calls setActiveCompany and updates activeCompanyId
 *  · Shows "no companies" message when allowedCompanies is empty
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CompanyProvider, useCompany, type Company } from '../context/CompanyContext';
import { CompanySwitcher } from '../components/CompanySwitcher';
import '../i18n'; // ensure i18n is initialised

// ── fixtures ─────────────────────────────────────────────────────────────────

const ALLOWED: Company[] = [
  { id: 'co-a', name: 'Alpha Corp' },
  { id: 'co-b', name: 'Beta Ltd' },
];

const UNAUTHORIZED_ID = 'co-secret';

function Wrapper({
  allowedCompanies,
  children,
}: {
  allowedCompanies: Company[];
  children: ReactNode;
}) {
  return (
    <CompanyProvider allowedCompanies={allowedCompanies}>
      {children}
    </CompanyProvider>
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CompanySwitcher — allowed companies display', () => {
  it('renders an option for each company in the allowed list', () => {
    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
      </Wrapper>,
    );

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveValue('co-a');
    expect(options[1]).toHaveValue('co-b');
  });

  it('shows the company name as option text', () => {
    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
      </Wrapper>,
    );

    expect(screen.getByText('Alpha Corp')).toBeTruthy();
    expect(screen.getByText('Beta Ltd')).toBeTruthy();
  });

  it('does NOT render an option for an unauthorized company id', () => {
    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
      </Wrapper>,
    );

    const options = screen.getAllByRole('option');
    const ids = options.map(o => (o as HTMLOptionElement).value);
    expect(ids).not.toContain(UNAUTHORIZED_ID);
  });

  it('shows "no companies" message when allowedCompanies is empty', () => {
    render(
      <Wrapper allowedCompanies={[]}>
        <CompanySwitcher />
      </Wrapper>,
    );

    // No select element
    expect(screen.queryByRole('combobox')).toBeNull();
    // Status message present (either Arabic or English depending on i18n init)
    const status = screen.getByRole('status');
    expect(status).toBeTruthy();
  });
});

describe('CompanySwitcher — company switching', () => {
  it('selecting a company updates activeCompanyId in the context', () => {
    let capturedId: string | null = null;

    function Inspector() {
      const { activeCompanyId } = useCompany();
      capturedId = activeCompanyId;
      return null;
    }

    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
        <Inspector />
      </Wrapper>,
    );

    // Initial: first allowed company is active
    expect(capturedId).toBe('co-a');

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'co-b' } });

    expect(capturedId).toBe('co-b');
  });

  it('the select value reflects the active company', () => {
    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
      </Wrapper>,
    );

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    // Initial value is first company
    expect(select.value).toBe('co-a');

    fireEvent.change(select, { target: { value: 'co-b' } });
    expect(select.value).toBe('co-b');
  });

  it('changing company clears old company-scoped state (companyKey increments)', () => {
    let capturedKey = -1;

    function KeyInspector() {
      const { companyKey } = useCompany();
      capturedKey = companyKey;
      return null;
    }

    render(
      <Wrapper allowedCompanies={ALLOWED}>
        <CompanySwitcher />
        <KeyInspector />
      </Wrapper>,
    );

    const initial = capturedKey;
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'co-b' } });

    expect(capturedKey).toBe(initial + 1);
  });
});
