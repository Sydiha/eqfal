import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PayrollBonusSelection } from '../components/PayrollBonusSelection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'ar' } }) }));
afterEach(() => vi.unstubAllGlobals());

it('loads recognized options for the posting draft and returns the selected installment', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ options: [
    { entitlement_id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31', maximum: '10000.00' },
  ] })));
  vi.stubGlobal('fetch', fetch);
  const onSelect = vi.fn();
  render(<PayrollBonusSelection draftId="draft" disabled={false} onUnauthorized={vi.fn()} onSelect={onSelect} />);
  const amount = await screen.findByRole('spinbutton', { name: /سارة/ });
  expect(fetch).toHaveBeenCalledWith('/api/payroll/drafts/draft/bonus-options', expect.objectContaining({ credentials: 'same-origin' }));
  expect(amount).toHaveAttribute('max', '10000.00');
  fireEvent.change(amount, { target: { value: '10000' } });
  expect(onSelect).toHaveBeenCalledWith([{ entitlement_id: 'bonus', amount: '10000' }]);
});
