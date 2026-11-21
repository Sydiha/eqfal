import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeeBonusBankPayment } from '../components/EmployeeBonusBankPayment';

afterEach(() => vi.unstubAllGlobals());

it('uses the existing settlement API and retains the same request key after a failed attempt', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ bank_transactions: [
      { id: 'bank', transaction_date: '2026-04-15', bank_reference: 'REF', remaining_amount: '11000.00' },
    ] }), { status: 200 }))
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const onSaved = vi.fn();
  render(<EmployeeBonusBankPayment liabilityLine="liability" arabic onSaved={onSaved} onUnauthorized={vi.fn()} />);
  fireEvent.click(screen.getByText('تسوية بنكية مباشرة'));
  fireEvent.click(screen.getByRole('button', { name: 'تحميل الحركات المتاحة' }));
  fireEvent.change(await screen.findByLabelText('حركة البنك'), { target: { value: 'bank' } });
  fireEvent.change(screen.getByLabelText('مبلغ التسوية'), { target: { value: '11000' } });
  fireEvent.click(screen.getByRole('button', { name: 'تسجيل التسوية' }));
  await screen.findByText(/تعذر الاتصال/);
  fireEvent.click(screen.getByRole('button', { name: 'تسجيل التسوية' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[2]).toEqual(fetch.mock.calls[1]);
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toMatchObject({
    bank_transaction_id: 'bank', liability_line_id: 'liability', amount: '11000',
  });
});
