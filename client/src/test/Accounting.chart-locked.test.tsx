import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Accounting } from '../components/Accounting';

// The Chart of Accounts tab (approved Figma 180:1142) is LOCKED. These checks fail
// if its rendered markup or its dedicated source files change.
const accounts = [
  { id: '00000000-0000-4000-8000-000000000001', code: '1000', name: 'Bank', account_type: 'asset', parent_account_id: null, is_active: true },
  { id: '00000000-0000-4000-8000-000000000002', code: '2000', name: 'Payables', account_type: 'liability', parent_account_id: null, is_active: false },
];
const classifications = [
  { account_id: accounts[0]!.id, code: '1000', name: 'Bank', account_type: 'asset', is_active: true, statement_category: 'current_asset', cash_role: 'cash', cash_flow_activity: null, counterparty_account_id: null },
];

const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }));
  if (url.startsWith('/api/account-classifications')) return new Response(JSON.stringify({ accounts: classifications }));
  if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [] }));
  if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
  return new Response(JSON.stringify({ sources: [] }));
}));

const sha = (file: string) => createHash('sha256').update(readFileSync(resolve(__dirname, '../components', file))).digest('hex');

describe('Chart of Accounts tab is locked', () => {
  beforeEach(async () => { await i18n.changeLanguage('ar'); window.history.replaceState(null, '', '/?page=accounting'); });

  it('renders the same chart workspace and mapping panel markup', async () => {
    stub();
    const { container } = render(<Accounting canView canCreateChart canEditChart canCreateJournal canEditJournal canPost onUnauthorized={vi.fn()} />);
    await screen.findAllByText('Bank');
    await waitFor(() => expect(container.querySelectorAll('.ac-mapping tbody tr')).toHaveLength(1));
    expect(container.querySelector('.ac-approved__accounts')!.outerHTML).toMatchSnapshot('chart-workspace');
    expect(container.querySelector('.ac-mapping')!.outerHTML).toMatchSnapshot('mapping-panel');
  });

  it('keeps the chart-only source files byte-identical', () => {
    expect({
      'AccountingApproved.css': sha('AccountingApproved.css'),
      'AccountClassificationPanel.tsx': sha('AccountClassificationPanel.tsx'),
      'Accounting.tsx': sha('Accounting.tsx'),
    }).toMatchSnapshot('chart-source-hashes');
  });
});
