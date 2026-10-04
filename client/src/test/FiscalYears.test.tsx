import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { FiscalYears } from '../components/FiscalYears';

const openYear = { id: 'fy-1', name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' as const };
const closedYear = { ...openYear, id: 'fy-0', name: 'FY 2025', status: 'closed' as const };

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
});

describe('FiscalYears', () => {
  it('renders loading, empty, and error states', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveResponse = resolve; })));
    const view = render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading fiscal years');
    resolveResponse(new Response(JSON.stringify({ fiscalYears: [] }), { status: 200 }));
    expect(await screen.findByText('No fiscal years have been created yet.')).toBeInTheDocument();
    view.unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load');
  });

  it('enforces view/manage presentation and only offers edit for open years', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { rerender } = render(<FiscalYears canView={false} canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fiscalYears: [openYear, closedYear] }), { status: 200 })));
    rerender(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('FY 2026')).toBeInTheDocument();
    expect(screen.getAllByText('Edit')).toHaveLength(1);
    expect(screen.getAllByText('Close')).toHaveLength(1);
    expect(screen.getByText('Create fiscal year')).toBeInTheDocument();
  });

  it('maps each action to its exact capability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 })));
    const view = render(<FiscalYears canView canCreate canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    await screen.findByText('FY 2026');
    expect(screen.getByText('Create fiscal year')).toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Close')).not.toBeInTheDocument();
    view.rerender(<FiscalYears canView canCreate={false} canEdit canClose={false} onUnauthorized={vi.fn()}/>);
    expect(screen.queryByText('Create fiscal year')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.queryByText('Close')).not.toBeInTheDocument();
  });

  it('creates without a company_id and closes with an optional reason after confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYear: openYear }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYear: closedYear }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [closedYear] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    await screen.findByText('FY 2026');
    fireEvent.click(screen.getByText('Create fiscal year'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'FY 2027' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-12-31' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: 'FY 2027', start_date: '2027-01-01', end_date: '2027-12-31' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText(/current functionality/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Approved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ reason: 'Approved' });
  });

  it('successfully edits an open fiscal year', async () => {
    const updated = { ...openYear, name: 'Updated FY' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYear: updated }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [updated] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    await screen.findByText('FY 2026');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated FY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Updated FY')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/fiscal-years/fy-1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
  });

  it('does not submit when the start and end dates are equal', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    await screen.findByText('No fiscal years have been created yet.');

    fireEvent.click(screen.getByText('Create fiscal year'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invalid FY' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('end date must be after');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [403, 'do not have permission to perform'],
    [409, 'conflicts with an existing year'],
  ])('maps API status %s to a specific message', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    const view = render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    view.unmount();
  });

  it('provides basic Fiscal Year text in English and Arabic', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const view = render(<FiscalYears canView={false} canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(screen.getByText('You do not have permission to view fiscal years.')).toBeInTheDocument();
    await i18n.changeLanguage('ar');
    view.rerender(<FiscalYears canView={false} canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(screen.getByText('ليس لديك صلاحية عرض السنوات المالية.')).toBeInTheDocument();
  });

  it('delegates a 401 to the shared unauthorized handler', async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={unauthorized}/>);
    await waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
  });

  it('renders the Figma summary and register from the loaded years only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fiscalYears: [openYear, closedYear] }), { status: 200 })));
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    await screen.findByText('FY 2026');
    const summary = screen.getByLabelText('Fiscal years summary');
    expect(summary).toHaveTextContent('Number of fiscal years2');
    expect(summary).toHaveTextContent('Open years1');
    expect(summary).toHaveTextContent('Closed years1');
    expect(screen.getByText('2 fiscal years')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Fiscal year', 'Start date', 'End date', 'Status', 'Actions']);
    const closedRow = screen.getByText('FY 2025').closest('tr')!;
    expect(closedRow).toHaveTextContent('Closed');
    expect(closedRow.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the empty register state and Arabic register count', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 })));
    await i18n.changeLanguage('ar');
    const view = render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('سنة مالية واحدة')).toBeInTheDocument();
    view.unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fiscalYears: [] }), { status: 200 })));
    render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('لا توجد سنوات مالية')).toBeInTheDocument();
    expect(screen.getByText('لم يتم إنشاء أي سنة مالية بعد.')).toBeInTheDocument();
  });

  it('marks the date fields on an invalid range and shows the saving state without new rules', async () => {
    let resolveSave!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [openYear] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()}/>);
    await screen.findByText('FY 2026');
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    fireEvent.click(screen.getByText('Create fiscal year'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'FY 2027' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-12-31' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-01-01' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The end date must be after the start date.');
    expect(screen.getByLabelText('Start date')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('End date')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-12-31' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    resolveSave(new Response(JSON.stringify({ fiscalYear: openYear }), { status: 201 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
