import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { CompanyProvider, useCompany, type Company } from '../context/CompanyContext';
import { CompanySwitcher } from '../components/CompanySwitcher';
import '../i18n';

const ALLOWED: Company[] = [
  { id: 'co-a', name: 'Alpha Corp' },
  { id: 'co-b', name: 'Beta Ltd' },
];

function Inspector({ capture }: { capture: (id: string | null) => void }) {
  const { activeCompanyId } = useCompany();
  capture(activeCompanyId);
  return null;
}

describe('CompanySwitcher — server validation boundary', () => {
  it('does not change local tenant state when the server rejects the switch', async () => {
    let active: string | null = null;
    const onSwitch = vi.fn().mockResolvedValue(false);

    render(
      <MantineProvider><CompanyProvider allowedCompanies={ALLOWED}>
        <CompanySwitcher onSwitch={onSwitch} />
        <Inspector capture={(id) => { active = id; }} />
      </CompanyProvider></MantineProvider>,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'co-b' } });

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('co-b'));
    expect(active).toBe('co-a');
  });

  it('changes local tenant state only after the server accepts the switch', async () => {
    let active: string | null = null;
    const onSwitch = vi.fn().mockResolvedValue(true);

    render(
      <MantineProvider><CompanyProvider allowedCompanies={ALLOWED}>
        <CompanySwitcher onSwitch={onSwitch} />
        <Inspector capture={(id) => { active = id; }} />
      </CompanyProvider></MantineProvider>,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'co-b' } });

    await waitFor(() => expect(active).toBe('co-b'));
  });
});
