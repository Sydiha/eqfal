import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { HistoricalRecords } from '../components/HistoricalRecords';
import { canShowNavigationPage } from '../components/navigationVisibility';
import { isValidAmount, normalizeAmount } from '../components/historicalLabels';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const period = { id: 'p1', label: 'FY 2023', period_start: '2023-01-01', period_end: '2023-12-31', completeness: 'incomplete', reconstruction_status: 'in_progress', status_reason: 'start', version_count: 2 };
const base = { period_id: 'p1', statement_type: 'financial_position', functional_currency: 'USD', submitted_to: null, submission_date: null, submission_reference: null, proof_level: null, proof_document_id: null,
  internal_purpose: null, basis_version_id: null, source_type: null, confidence: null, evidence_reference: null, evidence_document_id: null, method_note: null, fingerprint: null, sealed_at: null,
  review_status: 'none', reviewed_at: null, approved_at: null, void_reason: null, created_at: '2023-02-01T00:00:00Z' };
const official = { ...base, id: 'v1', kind: 'official', version_no: 1, state: 'sealed', submitted_to: 'ZATCA', submission_date: '2023-03-01', proof_level: 'declared_unverified', fingerprint: 'a'.repeat(64), sealed_at: '2023-03-02T00:00:00Z', provenance: 'official_declared_unverified' };
const draft = { ...base, id: 'v2', kind: 'internal', version_no: 2, state: 'draft', internal_purpose: 'reconstruction', source_type: 'bank_statement', confidence: 'high', basis_version_id: 'v1', provenance: 'internal_reconstruction' };
const lines = [{ id: 'l1', line_no: 1, line_code: 'CASH', label_ar: 'النقد', label_en: 'Cash', amount: '1000.00', supporting_document_id: null, note: null }];

function stub(opts: { versions?: unknown[]; versionOverride?: Record<string, unknown>; post?: (url: string, body: any, method: string) => Response } = {}) {
  const versions = opts.versions ?? [official, draft];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return opts.post ? opts.post(url, init?.body ? JSON.parse(String(init.body)) : {}, method) : json({ version: draft, period, line: lines[0] });
    if (url === '/api/historical/periods') return json({ periods: [period] });
    if (url === '/api/historical/periods/p1') return json({ period, versions });
    if (url === '/api/documents') return json({ documents: [{ id: 'd1', original_filename: 'filing.pdf' }] });
    const m = /^\/api\/historical\/versions\/(v\d)(\/history|\/comparison.*)?$/.exec(url);
    if (m) {
      const v = (versions as any[]).find((x) => x.id === m[1]);
      if (m[2] === '/history') return json({ versions });
      if (m[2]?.startsWith('/comparison')) return json({ version: { ...draft, id: 'v2', provenance: 'internal_reconstruction' }, basis: { ...official, id: 'v1' }, basis_source: 'declared_basis',
        lines: [{ line_code: 'CASH', label_ar: 'النقد', label_en: 'Cash', basis_amount: '900.00', version_amount: '1000.00', difference: '100.00', status: 'changed' },
          { line_code: 'AR', label_ar: null, label_en: 'Receivables', basis_amount: '50.00', version_amount: null, difference: '-50.00', status: 'only_in_basis' }],
        summary: { matching: 0, changed: 1, only_in_basis: 1, only_in_version: 0, net_difference: '50.00' }, read_only: true });
      return json({ version: { ...v, ...(opts.versionOverride ?? {}) }, lines });
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, i]) => i?.method && i.method !== 'GET').map(([u, i]) => ({ url: u as string, method: i.method as string, body: JSON.parse(String(i.body ?? '{}')) }));
const open = async () => { fireEvent.click(await screen.findByRole('button', { name: /Open|فتح/ })); await screen.findByRole('heading', { name: 'FY 2023' }); };

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('HistoricalRecords periods', () => {
  it('shows loading, then the list with status labels, in LTR English and RTL Arabic', async () => {
    stub();
    const en = render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByText('FY 2023')).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(en.container.querySelector('section')).toHaveAttribute('dir', 'ltr');
    en.unmount();
    await i18n.changeLanguage('ar');
    const ar = render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('غير مكتملة')).toBeInTheDocument();
    expect(screen.getByText('قيد الإعداد')).toBeInTheDocument();
    expect(ar.container.querySelector('section')).toHaveAttribute('dir', 'rtl');
  });

  it('shows an empty state and a retry on load failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ periods: [] })));
    const { unmount } = render(<HistoricalRecords canManage={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('No historical periods yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New period' })).toBeNull();
    unmount();
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'X' }, 500)));
    render(<HistoricalRecords canManage={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('The periods could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('hides write and approve actions from a view-only user', async () => {
    stub();
    render(<HistoricalRecords canManage={false} canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    for (const name of ['Update status', 'Record official submission', 'New internal reconstruction', 'Reopen reconstruction', 'New period']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('creates a period with a required reason and shows an actionable Arabic overlap message', async () => {
    await i18n.changeLanguage('ar');
    const f = stub({ post: () => json({ error: 'x', code: 'HISTORICAL_PERIOD_OVERLAP' }, 409) });
    render(<HistoricalRecords canManage canApprove={false} onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'فترة جديدة' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'إنشاء الفترة' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('اسم الفترة'), { target: { value: 'FY 2022' } });
    fireEvent.change(within(dialog).getByLabelText('من تاريخ'), { target: { value: '2022-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('إلى تاريخ'), { target: { value: '2022-12-31' } });
    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), { target: { value: 'سجلات قديمة' } });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('تتداخل هذه الفترة');
    expect(posts(f)[0]).toMatchObject({ url: '/api/historical/periods', method: 'POST', body: { label: 'FY 2022', period_start: '2022-01-01', completeness: 'incomplete', reason: 'سجلات قديمة' } });
  });

  it('reopens a completed reconstruction only with approve permission, a reason and confirmation', async () => {
    const completed = { ...period, reconstruction_status: 'completed' };
    const f = vi.fn(async (url: string, init?: RequestInit) => init?.method === 'POST' ? json({ period }) : url === '/api/historical/periods' ? json({ periods: [completed] }) : json({ period: completed, versions: [] }));
    vi.stubGlobal('fetch', f);
    const manageOnly = render(<HistoricalRecords canManage canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    expect(screen.queryByRole('button', { name: 'Reopen reconstruction' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New internal reconstruction' })).toBeDisabled();
    manageOnly.unmount();
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen reconstruction' }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Reopen' });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason for reopening (required)'), { target: { value: 'new documents found' } });
    expect(go).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(go);
    await waitFor(() => expect(posts(f)[0]).toMatchObject({ url: '/api/historical/periods/p1/reopen-reconstruction', body: { reason: 'new documents found', confirm: true } }));
  });
});

describe('HistoricalRecords versions', () => {
  it('records a user-declared submission without proof only after an explicit unverified acknowledgement', async () => {
    const f = stub({ post: () => json({ version: { ...official, id: 'v1' } }, 201) });
    render(<HistoricalRecords canManage canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Record official submission' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Statement currency (3-letter code)'), { target: { value: 'usd' } });
    fireEvent.change(within(dialog).getByLabelText('Submitted to'), { target: { value: 'ZATCA' } });
    fireEvent.change(within(dialog).getByLabelText('Submission date'), { target: { value: '2023-03-01' } });
    expect(within(dialog).getByRole('note')).toHaveTextContent('UNVERIFIED');
    const create = within(dialog).getByRole('button', { name: 'Create draft' });
    expect(create).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(posts(f)[0]).toMatchObject({ url: '/api/historical/periods/p1/versions', body: { kind: 'official', functional_currency: 'USD', proof_level: 'declared_unverified', proof_document_id: null } }));
  });

  it('requires an existing company document when proof is attached', async () => {
    const f = stub({ post: () => json({ version: official }, 201) });
    render(<HistoricalRecords canManage canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Record official submission' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Statement currency (3-letter code)'), { target: { value: 'SAR' } });
    fireEvent.change(within(dialog).getByLabelText('Submitted to'), { target: { value: 'ZATCA' } });
    fireEvent.change(within(dialog).getByLabelText('Submission date'), { target: { value: '2023-03-01' } });
    fireEvent.click(within(dialog).getByLabelText(/With proof/));
    const create = within(dialog).getByRole('button', { name: 'Create draft' });
    expect(create).toBeDisabled();
    fireEvent.change(await within(dialog).findByLabelText('Proof document'), { target: { value: 'd1' } });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    await waitFor(() => expect(posts(f)[0]?.body).toMatchObject({ proof_level: 'proof_attached', proof_document_id: 'd1' }));
  });

  it('labels the four provenance kinds distinctly and never presents internal approval as government acceptance', async () => {
    stub({ versions: [official, draft, { ...draft, id: 'v3', version_no: 3, internal_purpose: 'correction', provenance: 'internal_correction' }, { ...official, id: 'v4', version_no: 4, proof_level: 'proof_attached', provenance: 'official_submitted_with_proof' }] });
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    expect(screen.getAllByText('Official submission declared by the user — UNVERIFIED').length).toBeGreaterThan(0);
    expect(screen.getByText('Internal reconstruction')).toBeInTheDocument();
    expect(screen.getByText('Internal correction')).toBeInTheDocument();
    expect(screen.getByText('Official submission — with supporting proof')).toBeInTheDocument();
  });

  it('draft: edits lines, validates the manual line code and amount, and seals only after explicit confirmation', async () => {
    const f = stub({ versions: [official, draft], versionOverride: { id: 'v2' }, post: (url) => json(url.endsWith('/seal') ? { version: draft } : { line: lines[0] }, 201) });
    render(<HistoricalRecords canManage canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
    await screen.findByText('Statement lines');
    expect(screen.getByText('1,000.00 USD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    let dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save line' });
    fireEvent.change(within(dialog).getByLabelText(/Line code/), { target: { value: 'AR_TRADE' } });
    fireEvent.change(within(dialog).getByLabelText('English label'), { target: { value: 'Receivables' } });
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '12.345' } });
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/at most 2 decimals/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '٢٥٠٫٥٠' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(posts(f)[0]).toMatchObject({ url: '/api/historical/versions/v2/lines', body: { line_code: 'AR_TRADE', amount: '250.50' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));
    dialog = await screen.findByRole('dialog');
    const seal = within(dialog).getByRole('button', { name: 'Seal permanently' });
    expect(seal).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(seal);
    await waitFor(() => expect(posts(f).some((p) => p.url === '/api/historical/versions/v2/seal' && p.body.confirm === true)).toBe(true));
  });

  it('sealed: no line editing; offers a correction and an internal-only review with a disclaimer', async () => {
    const f = stub({ versionOverride: { review_status: 'reviewed' }, post: () => json({ version: official }, 200) });
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    await screen.findByText('Statement lines');
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Seal version' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create internal correction' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve internally' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('do not mean any authority accepted the record');
    const go = within(dialog).getByRole('button', { name: 'Approve internally' });
    expect(go).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(go);
    await waitFor(() => expect(posts(f)[0]).toMatchObject({ url: '/api/historical/versions/v1/review', body: { action: 'approve', confirm: true } }));
  });

  it('hides review and correction actions from a user without those permissions', async () => {
    stub();
    render(<HistoricalRecords canManage={false} canApprove={false} onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    await screen.findByText('Statement lines');
    for (const name of ['Create internal correction', 'Record internal review', 'Approve internally', 'Add line']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('compares versions with original/compared amounts, difference, missing lines and the version currency (not assumed SAR)', async () => {
    stub({ versionOverride: { ...draft } });
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
    await screen.findByText('Financial comparison');
    fireEvent.click(screen.getByRole('button', { name: 'Show comparison' }));
    expect(await screen.findByText('900.00 USD')).toBeInTheDocument();
    expect(screen.getByText('100.00 USD')).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.getByText('Only in original')).toBeInTheDocument();
    expect(screen.getByText('Original amount')).toBeInTheDocument();
    expect(screen.getByText('Compared amount')).toBeInTheDocument();
    expect(screen.queryByText(/SAR/)).toBeNull();
  });


  it('blocks comparison when the declared basis is in another currency (English and Arabic) and calls no comparison endpoint', async () => {
    const f = stub({ versions: [{ ...official, functional_currency: 'EUR' }, draft], versionOverride: { ...draft } });
    const view = render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
    await screen.findByText('Financial comparison');
    expect(await screen.findByTestId('currency-mismatch')).toHaveTextContent('this version is in USD and the compared version is in EUR');
    expect(screen.getByRole('button', { name: 'Show comparison' })).toBeDisabled();
    expect(f.mock.calls.some(([u]) => String(u).includes('/comparison'))).toBe(false);
    view.unmount();
    await i18n.changeLanguage('ar');
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'فتح' }));
    await screen.findByRole('heading', { name: 'FY 2023' });
    fireEvent.click(screen.getAllByRole('button', { name: 'فتح' })[1]!);
    expect(await screen.findByTestId('currency-mismatch')).toHaveTextContent('عملة هذه النسخة USD وعملة النسخة المقارَن بها EUR');
  });

  it('blocks an explicitly selected version in another currency and allows one in the same currency', async () => {
    const eur = { ...official, id: 'v5', version_no: 5, functional_currency: 'EUR' };
    const noBasis = { ...draft, basis_version_id: null };
    const f = stub({ versions: [official, noBasis, eur], versionOverride: { ...noBasis } });
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
    await screen.findByText('Financial comparison');
    const show = screen.getByRole('button', { name: 'Show comparison' });
    expect(show).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'v5' } });
    expect(await screen.findByTestId('currency-mismatch')).toBeInTheDocument();
    expect(show).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'v1' } });
    expect(screen.queryByTestId('currency-mismatch')).toBeNull();
    expect(show).toBeEnabled();
    fireEvent.click(show);
    expect(await screen.findByText('900.00 USD')).toBeInTheDocument();
    expect(f.mock.calls.filter(([u]) => String(u).includes('/comparison')).length).toBe(1);
  });

  it('remounting for another company reloads from scratch (company-scoped data is not kept)', async () => {
    const f = stub();
    const first = render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await screen.findByText('FY 2023');
    first.unmount();
    render(<HistoricalRecords canManage canApprove onUnauthorized={vi.fn()} />);
    await screen.findByText('FY 2023');
    expect(f.mock.calls.filter(([u]) => u === '/api/historical/periods').length).toBe(2);
  });
});

describe('historical helpers and navigation', () => {
  it('shows the page only with historical.view', () => {
    expect(canShowNavigationPage('historicalRecords', ['historical.view'])).toBe(true);
    expect(canShowNavigationPage('historicalRecords', ['historical.manage', 'historical.approve'])).toBe(false);
  });
  it('validates amounts like the API and normalizes Arabic-Indic digits', () => {
    expect(isValidAmount('-12.5')).toBe(true);
    expect(isValidAmount('12.345')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(normalizeAmount('١٬٢٣٤٫٥٠')).toBe('1234.50');
  });
});
