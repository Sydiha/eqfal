import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { CustodyPanel } from '../components/CustodyPanel';

const tx = { id: 't1', transaction_date: '2026-02-01', description: 'Advance', bank_reference: null, amount: '-1000.00', currency_code: 'SAR', reconciliation_status: 'matched' };
const summary = (id: string, purpose: string) => ({ custody: { id, purpose, status: 'open', holder_user_id: 'u', recipient_display_name: 'Sara' }, funding_transaction: tx, funded_amount: '1000.00', allocated_amount: '0.00', returned_amount: '0.00', remaining_amount: '1000.00', derived_status: 'open', allocations: [], returns: [] });
const DOC = { id: '11111111-1111-4111-8111-111111111111', original_filename: 'inv.pdf', reference_number: 'INV-77', counterparty_name: 'Acme', document_date: '2026-02-01', total_amount: '250.00' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function setup(post: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/custodies') return json({ custodies: [summary('c-a', 'Custody A'), summary('c-b', 'Custody B')] });
    if (url === '/api/bank-transactions') return json({ transactions: [] });
    if (url === '/api/custody/recipients') return json({ recipients: [] });
    if (url === '/api/custody/account-mapping') return json({ mapping: { account_id: 'x', code: '1150', name: 'Advances', valid: true }, can_edit: false });
    if (url.includes('/eligible-documents')) return json({ documents: [DOC] });
    if (init?.method === 'POST' && url.endsWith('/documents')) return post();
    return json({});
  }));
  render(<MantineProvider><CustodyPanel canView canManage canClose={false} onUnauthorized={vi.fn()} /></MantineProvider>);
  return calls;
}
const posts = (calls: { url: string; init?: RequestInit }[]) => calls.filter(c => c.init?.method === 'POST');
async function pickDocument() {
  fireEvent.click(await screen.findByRole('button', { name: /INV-77/ }));
  await screen.findByRole('button', { name: 'Change' });
}

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('CustodyPanel document allocation', () => {
  it('keeps the selected document, amount and note when the request fails, and clears them only after success', async () => {
    let ok = false;
    const calls = setup(() => (ok ? json({}, 201) : json({ error: 'Document already has a funding source' }, 409)));
    await pickDocument();
    fireEvent.change(screen.getAllByLabelText('Note')[0]!, { target: { value: 'taxi to client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Document already has a funding source');
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount/)).toHaveValue('250');
    expect(screen.getAllByLabelText('Note')[0]!).toHaveValue('taxi to client');
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Amount/)).toHaveValue('');
    expect(screen.getAllByLabelText('Note')[0]!).toHaveValue('');
    expect(posts(calls)).toHaveLength(2);
    expect(JSON.parse(String(posts(calls)[0]!.init!.body))).toEqual({ document_id: DOC.id, amount: '250', note: 'taxi to client' });
  });

  it('never submits a document chosen under custody A for custody B', async () => {
    const calls = setup(() => json({}, 201));
    await pickDocument();
    fireEvent.change(screen.getAllByLabelText('Note')[0]!, { target: { value: 'for A' } });
    fireEvent.change(screen.getByLabelText('Select custody'), { target: { value: 'c-b' } });
    await screen.findByRole('button', { name: /INV-77/ });
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Amount/)).toHaveValue('');
    expect(screen.getAllByLabelText('Note')[0]!).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add document' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    expect(posts(calls)).toHaveLength(0);
    expect(calls.some(c => c.url === '/api/custodies/c-b/eligible-documents?q=')).toBe(true);
  });
});
