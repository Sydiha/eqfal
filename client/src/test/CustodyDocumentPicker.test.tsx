import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { CustodyDocumentPicker, EligibleDocument } from '../components/CustodyDocumentPicker';

const DOC: EligibleDocument = { id: '11111111-1111-4111-8111-111111111111', original_filename: 'inv.pdf', reference_number: 'INV-77', counterparty_name: 'Acme Supplies', document_date: '2026-02-01', total_amount: '250.00' };
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
function renderPicker(over: Partial<React.ComponentProps<typeof CustodyDocumentPicker>> = {}) {
  const props = { custodyId: 'c1', currency: 'SAR', language: 'en', refreshKey: 0, selected: null, onSelect: vi.fn(), onUnauthorized: vi.fn(), ...over };
  return { props, ...render(<MantineProvider><CustodyDocumentPicker {...props} /></MantineProvider>) };
}
beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('CustodyDocumentPicker', () => {
  it('lists eligible documents with reference, supplier, date, amount and currency, and selects one without any UUID field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ documents: [DOC] })));
    const { props } = renderPicker();
    const option = await screen.findByRole('button', { name: /INV-77|Acme|بلا/ });
    expect(option).toHaveTextContent('INV-77');
    expect(option).toHaveTextContent('Acme Supplies');
    expect(option).toHaveTextContent('250.00');
    expect(option).toHaveTextContent('SAR');
    expect(screen.queryByText(DOC.id)).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(props.onSelect).toHaveBeenCalledWith(DOC);
    expect(fetch).toHaveBeenCalledWith('/api/custodies/c1/eligible-documents?q=');
  });

  it('shows the empty state, the loading state, and a search error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ documents: [] })));
    const first = renderPicker();
    expect(screen.getByText('Searching documents…')).toBeInTheDocument();
    expect(await screen.findByText(/No eligible documents found/)).toBeInTheDocument();
    first.unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Custody is closed' }), { status: 409 })));
    renderPicker();
    expect(await screen.findByRole('alert')).toHaveTextContent('Custody is closed');
  });

  it('searches with the typed text, sent URL-encoded', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok({ documents: [] }));
    vi.stubGlobal('fetch', fetchMock);
    renderPicker();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'acme & co' } });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/custodies/c1/eligible-documents?q=acme%20%26%20co'));
  });

  it('shows the chosen document with a Change button and does not search while one is selected', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { props } = renderPicker({ selected: DOC });
    expect(screen.getByText('INV-77')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(props.onSelect).toHaveBeenCalledWith(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ documents: [{ ...DOC, reference_number: null, counterparty_name: null, document_date: null }] })));
    renderPicker({ language: 'ar' });
    const option = await screen.findByRole('button', { name: /INV-77|Acme|بلا/ });
    expect(option).toHaveTextContent('بلا مورد');
    expect(option).toHaveTextContent('بلا تاريخ');
  });
});
