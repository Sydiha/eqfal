import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Banking } from '../components/Banking';
import { ObligationsAging, type AgingReport } from '../components/ObligationsAging';
import { PersonalPayments } from '../components/PersonalPayments';
import i18n from '../i18n';

const css = (name: string) => readFileSync(resolve(__dirname, '../components', name), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('PR-4 bank import history', () => {
  beforeEach(async () => { await i18n.changeLanguage('ar'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps the stored filename text, isolates it, labels every cell and keeps Resume/Delete reachable', async () => {
    const filename = 'كشف-حساب-أكتوبر-2026.xlsx';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/bank-accounts')) return json({ accounts: [{ id: 'a1', display_name: 'Main', bank_name: null, currency_code: 'SAR', is_active: true }] });
      if (url.includes('/api/bank-import-batches')) return json({ batches: [{ id: 'b1', bank_account_id: 'a1', original_filename: filename, status: 'preview_ready', total_rows: 80, valid_rows: 70, duplicate_rows: 5, invalid_rows: 5, created_at: '2026-10-21T10:00:00Z' }] });
      return json({ transactions: [] });
    }));
    render(<MantineProvider><Banking canView canImport canDeleteImport canManage={false} canMatch={false} canReconcile={false} onUnauthorized={vi.fn()} /></MantineProvider>);
    const name = await screen.findByText(filename);
    expect(name.tagName).toBe('BDI');
    expect(name).toHaveAttribute('dir', 'ltr');
    const row = name.closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells.every((td) => td.getAttribute('data-label'))).toBe(true);
    expect(within(row).getByRole('button', { name: i18n.t('banks.resume') })).toBeInTheDocument();
    expect(within(row).getAllByRole('button')).toHaveLength(2);
  });

  it('forces the actions to one line and stacks the table into labelled cards on narrow screens', () => {
    const c = css('banking-workspace.css');
    expect(c).toMatch(/\.bank-import-actions>\*\{flex-shrink:0;white-space:nowrap\}/);
    expect(c).toMatch(/\.bank-import-history td>bdi\{display:block\}/);
  });
});

describe('PR-4 aging report', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('labels every financial value so the mobile card layout is not anonymous', async () => {
    const side = { buckets: [], total_outstanding: '1220.00', item_count: 1, items: [{ obligation_id: 'r1', counterparty_name: 'Customer A', source_type: 'manual', recognized_on: '2026-01-01', due_on: '2026-05-30', original_amount: '1220.00', settled_amount: '0.00', outstanding_amount: '1220.00', days_overdue: 31, bucket: 'days_31_60' as const }] };
    const report: AgingReport = { as_of_date: '2026-06-30', receivables: side, payables: { ...side, items: [], item_count: 0, total_outstanding: '0.00' } };
    vi.stubGlobal('fetch', vi.fn(async () => json(report)));
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    const row = (await screen.findByText('Customer A')).closest('tr')!;
    const labels = Array.from(row.querySelectorAll('td')).map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Counterparty', 'Due date', 'Days overdue', 'Bucket', 'Outstanding']);
    expect(row).toHaveTextContent('1,220.00');
    // Date filter and exports share one toolbar.
    const toolbar = screen.getByLabelText('As of').closest('.ob-aging__toolbar')!;
    expect(within(toolbar as HTMLElement).getAllByRole('button', { name: /export|csv|pdf/i })).toHaveLength(3);
  });
});

describe('PR-4 personal payments', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('makes the new-payment action primary and labels the register cells with every action kept', async () => {
    const p = { id: 'p1', payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', treatment: 'new_expense', payment_date: '2026-03-12', accounting_date: '2026-03-10', amount: '500.00', purpose: 'Lunch', document_id: 'd1', obligation_id: null, expense_account_id: 'a1', counterparty_id: null, rejection_reason: null, version: 1, status: 'draft' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/payables')) return json({ as_of: '2026-10-18', payers: [] });
      if (url.endsWith('/payers')) return json({ payers: [] });
      return json({ payments: [p] });
    }));
    render(<PersonalPayments capabilities={['personal_payment.view', 'personal_payment.create', 'personal_payment.submit']} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /new personal payment/i })).toHaveClass('primary');
    const row = screen.getByText('Lunch').closest('tr')!;
    expect(Array.from(row.querySelectorAll('td')).every((td) => td.getAttribute('data-label'))).toBe(true);
    for (const name of [/edit/i, /delete|remove/i, /submit/i]) expect(within(row).getByRole('button', { name })).toBeInTheDocument();
  });
});

describe('PR-4 counterparty and settlement styles', () => {
  it('keeps the counterparty actions in one wrapping row and the form fields spaced', () => {
    const c = css('../shared-ui.css');
    expect(c).toMatch(/\.counterparty-manager li\{flex-direction:column/);
    expect(c).toMatch(/\.counterparty-form\{display:grid;gap:16px\}/);
  });
  it('removes the detached spinner controls on settlement amounts', () => {
    const src = css('SettlementPanel.tsx');
    expect(src.match(/<NumberInput hideControls/g)).toHaveLength(2);
  });
});
