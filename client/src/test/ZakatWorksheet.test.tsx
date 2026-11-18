import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { ZakatWorksheet } from '../components/ZakatWorksheet';

const props = { yearId: 'fy', canCreate: true, canEdit: true, canCreateAdjustment: true, canEditAdjustment: true, canDeleteAdjustment: true, canSubmit: true, canReview: true, canApprove: true, canCreateOwnership: true, canConfirmOwnership: true, canEditOwnership: true, canViewDocuments: true, onUnauthorized: () => undefined };
const gates = ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval', 'B1_hijri_denominator'].map((code) => ({ code, title: code, article_ref: 'Art.', blocks_approval: !code.startsWith('B1'), status: 'unverified' }));
const payload = (over: object = {}, amountCents = '1234500') => ({
  scope: { unsupported_reason: null, fiscal_year: { start_date: '2026-01-01', end_date: '2026-12-31' } },
  worksheet: { id: 'w', revision_no: 1, status: 'draft', version: 3, revision_reason: null, non_financing_confirmed: true, accounting_records_confirmed: true, snapshot_captured_at: '2027-01-02', balances_snapshot: { as_of_date: '2026-12-31', accounts: [{ account_id: 'a1', code: '1100', name: 'Stale cash', name_ar: 'النقدية', name_en: 'Cash', statement_category: 'current_asset', amount_cents: amountCents }] } },
  revisions: [{ id: 'w', revision_no: 1, status: 'draft', revision_reason: null, approved_at: null }],
  classifications: [], adjustments: [], eligibility: [],
  ownership_live: { qualified: false, blockers: ['no_confirmed_ownership'], as_of_date: '2026-12-31', total_ownership_bps4: '0', partners: [] },
  gates,
  readiness: { preparation_blockers: ['unclassified_balance'], gate_blockers: ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval'], unclassified_account_count: 1, can_submit: false, can_approve: false },
  preview: { status: 'BLOCKED', calculation_performed: false, final_zakat_base_halalas: null, payable_amount_halalas: null, totals: null, lines: [], blockers: [{ code: 'FINALIZED_BOOK_RESULT_REQUIRED', path: 'finalizedBookResult' }], missing_requirements: ['finalized_book_result', 'regulatory_gates'], worksheet_blockers: ['no_confirmed_ownership'], blocker_groups: { user_data: ['account_classifications', 'ownership_eligibility', 'finalized_book_result'], mapping: ['balances_source_drift', 'classification_mapping'], regulatory_review: ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval', 'regulatory_decision_evidence'] } },
  ...over,
});
const mockFetch = (amountCents?: string) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
  const url = String(u);
  if (url.includes('/api/documents')) return new Response(JSON.stringify({ documents: [] }));
  if (url.includes('/preview')) return new Response(JSON.stringify(payload({}, amountCents).preview));
  return new Response(JSON.stringify(payload({}, amountCents)));
});

describe('Zakat worksheet', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });
  it('is collapsed and does not fetch until opened', () => {
    const f = mockFetch(); render(<ZakatWorksheet {...props} />);
    expect(f).not.toHaveBeenCalled(); expect(screen.getByText('Zakat preparation worksheet')).toBeTruthy();
  });
  it('shows blockers and gates, withholds any payable amount, and disables submit/approve', async () => {
    mockFetch(); render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.getByText(/Zakat payable is withheld/)).toBeTruthy());
    expect(screen.getByText(/Classify every in-scope account, including zero-balance accounts/)).toBeTruthy();
    expect(screen.getAllByText(/Classify every in-scope account, including zero-balance accounts/)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Review account classifications' }).getAttribute('href')).toBe('#zakat-classification');
    expect(screen.getByText('B3 – Rounding rules')).toBeTruthy();
    expect(screen.getByText('B0 – Impact of amendment 1248')).toBeTruthy();
    expect(screen.getByText('B4 – Cap ordering (Arts. 23/25/29)')).toBeTruthy();
    expect(screen.getByText('B7 – Book profit after Zakat')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/payable amount:/i)).toBeNull();
    expect(screen.getByText('B9 – Accountant approval of reference cases')).toBeTruthy();
    expect(screen.getByText(/BLOCKED — required, validated inputs are missing/)).toBeTruthy();
    expect(screen.getByText('A finalized book result with evidence and actually recorded Zakat/tax charges is required.')).toBeTruthy();
    expect(screen.queryByText(/Equity component/)).toBeNull();
    expect(screen.getByLabelText('Professional review required')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Missing user-provided data' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Data mapping issues' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Refresh worksheet snapshots' }).getAttribute('href')).toBe('#zakat-worksheet');
    expect(screen.getByRole('link', { name: 'Correct unsupported mapping' }).getAttribute('href')).toBe('#zakat-classification');
    expect(screen.getByRole('heading', { name: 'Authorized regulatory review' })).toBeTruthy();
    expect(screen.getByText('Only the authorized accountant may resolve regulatory decisions.')).toBeTruthy();
  });
  it('disables approval and withholds the payable display when any of B0/B3/B4/B7/B9 is unresolved', async () => {
    const reviewed = payload({ worksheet: { ...payload().worksheet, status: 'reviewed' } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/api/documents')) return new Response(JSON.stringify({ documents: [] }));
      if (path.includes('/preview')) return new Response(JSON.stringify(reviewed.preview));
      return new Response(JSON.stringify(reviewed));
    });
    render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.queryByText(/payable amount:/i)).toBeNull();
    expect(screen.getByText(/Zakat payable is withheld/)).toBeTruthy();
  });
  it('renders a component breakdown only when the preview explicitly returns validated components', async () => {
    const f = mockFetch();
    f.mockImplementation(async (u) => {
      if (String(u).includes('/api/documents')) return new Response(JSON.stringify({ documents: [] }));
      if (String(u).includes('/preview')) return new Response(JSON.stringify({ status: 'COMPONENTS_ONLY', calculation_performed: false, final_zakat_base_halalas: null, payable_amount_halalas: null, totals: { equityAdditionsHalalas: '123456', equityReductionsHalalas: '0', equityNetHalalas: '123456', verifiedDeductibleAssetCandidatesHalalas: '0', article23ProfitDifferenceHalalas: '0' }, lines: [{ id: 'account-capital', component: 'equity', direction: 'addition', amountHalalas: '123456', includedInComponentTotals: true }], blockers: [], missing_requirements: [], worksheet_blockers: [], blocker_groups: { user_data: [], mapping: [], regulatory_review: [] } }));
      return new Response(JSON.stringify(payload()));
    });
    render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/Validated components only/)).toBeTruthy();
    expect(screen.getByText('Equity component')).toBeTruthy();
    expect(screen.getByText('1,234.56')).toBeTruthy();
    expect(screen.queryByText(/payable amount:/i)).toBeNull();
  });
  it('renders Arabic labels in Arabic UI', async () => {
    await i18n.changeLanguage('ar'); mockFetch(); render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    await waitFor(() => expect(screen.getByText(/مبلغ الزكاة المستحق محجوب/)).toBeTruthy());
    expect(screen.getByText('B3 – قواعد التقريب')).toBeTruthy(); expect(screen.getByText('B9 – اعتماد المحاسب للحالات المرجعية')).toBeTruthy(); expect(screen.getByText('النقدية', { exact: false })).toBeTruthy();
    expect(screen.getByText(/محظور — توجد مدخلات مطلوبة أو متحققة مفقودة/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'بيانات مطلوبة من المستخدم' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مراجعة تصنيفات الحسابات' }).getAttribute('href')).toBe('#zakat-classification');
    expect(screen.getByText('يلزم نتيجة دفترية نهائية مع أدلتها والرسوم الزكوية/الضريبية المسجلة فعلياً.')).toBeTruthy();
  });
  it('shows Arabic RTL decision evidence, reviewer and next action without releasing a blocked amount', async () => {
    await i18n.changeLanguage('ar');
    const reviewed = payload({
      worksheet: { ...payload().worksheet, status: 'reviewed' },
      regulatory_reviewers: [{ id: 'reviewer', name: 'المحاسب المعتمد' }],
      regulatory_decisions: [{
        id: 'decision', gate: 'B3', status: 'pending', can_approve: true,
        evidence_document_id: 'doc', authority_reference: 'دليل إثبات الفترة', facts: {},
      }],
      finalization: { status: 'BLOCKED', blockers: ['ARTICLE15_PERIOD_EVIDENCE_MISMATCH'], payable_amount_halalas: null },
    });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return new Response(null, { status: 204 });
      if (String(url).includes('/documents')) return new Response(JSON.stringify({ documents: [] }));
      return new Response(JSON.stringify(String(url).endsWith('/preview') ? reviewed.preview : reviewed));
    });
    render(<ZakatWorksheet {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    expect(await screen.findByRole('region', { name: 'المراجعة النظامية واعتماد الزكاة' })).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText(/المحاسب المعتمد/)).toBeInTheDocument();
    expect(screen.getByText(/راجع تاريخ بداية النشاط أو توقفه/)).toBeInTheDocument();
    expect(screen.getByText(/دليل إثبات الفترة/)).toBeInTheDocument();
    expect(screen.queryByText('الزكاة المستحقة')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الأدلة بعد التحقق' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/zakat-worksheets/fy/regulatory-decisions/decision/approve', expect.objectContaining({ method: 'POST', body: '{}' })));
  });

  it('shows the Arabic RTL reviewer administration and sends an explicit identity attestation', async () => {
    await i18n.changeLanguage('ar');
    const worksheetPayload = payload({ finalization: { status: 'BLOCKED', blockers: ['B0_amendment_1248'], payable_amount_halalas: null } });
    let appointments: Array<{ appointment_id: string; user_id: string; reviewer_name: string; reviewer_email: string; appointment_reference: string; identity_verified_at: string; revoked_at: string | null; revocation_reason: string | null }> = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const path = String(url);
      if (path === '/api/zakat-reviewers' && !options?.method) return new Response(JSON.stringify({ appointments, candidates: [{ user_id: 'member', name: 'مراجع', email: 'reviewer@example.test' }] }));
      if (path === '/api/zakat-reviewers' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body)) as { user_id: string; appointment_reference: string; identity_verified: boolean };
        expect(body.identity_verified).toBe(true);
        appointments = [{ appointment_id: 'appointment-1', user_id: body.user_id, reviewer_name: 'مراجع', reviewer_email: 'reviewer@example.test', appointment_reference: body.appointment_reference, identity_verified_at: '2026-01-01', revoked_at: null, revocation_reason: null }];
        return new Response(JSON.stringify(appointments[0]), { status: 201 });
      }
      if (path.includes('/preview')) return new Response(JSON.stringify(worksheetPayload.preview));
      if (path === '/api/documents') return new Response(JSON.stringify({ documents: [] }));
      return new Response(JSON.stringify(worksheetPayload));
    });
    render(<ZakatWorksheet {...props} canManageReviewers />);
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    const region = await screen.findByRole('region', { name: 'المراجعة النظامية واعتماد الزكاة' });
    expect(region).toHaveAttribute('dir', 'rtl');
    expect(await screen.findByRole('heading', { name: 'إدارة المراجعين المخوّلين' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('عضو الشركة'), { target: { value: 'member' } });
    fireEvent.change(screen.getByLabelText('مرجع التعيين المهني'), { target: { value: 'مراجع مهني' } });
    fireEvent.click(screen.getByLabelText(/تحققت من هوية المراجع/));
    fireEvent.click(screen.getByRole('button', { name: 'تعيين المراجع' }));
    expect(await screen.findByText(/appointment-1/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith('/api/zakat-reviewers', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText(/إعادة التعيين لا تعيد صلاحية اعتماد سابق/)).toBeInTheDocument();
  });

  it('renders the stored English account name in English UI and falls back for legacy snapshots', async () => {
    mockFetch(); const first = render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/Cash/)).toBeTruthy();
    expect(screen.queryByText(/Stale cash/)).toBeNull();
    first.unmount();
    const legacy = payload();
    legacy.worksheet!.balances_snapshot!.accounts[0] = { account_id: 'a1', code: '1100', name: 'Legacy cash', name_ar: '' as string, name_en: '' as string, statement_category: 'current_asset', amount_cents: '100' };
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/api/documents') ? new Response(JSON.stringify({ documents: [] })) : String(url).includes('/preview') ? new Response(JSON.stringify(legacy.preview)) : new Response(JSON.stringify(legacy))));
    render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/Legacy cash/)).toBeTruthy();
  });
  it('formats large snapshot minor-unit balances exactly', async () => {
    mockFetch('1234567890123456789'); render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('12,345,678,901,234,567.89')).toBeInTheDocument();
  });
  it('hides write controls without capabilities', async () => {
    mockFetch(); render(<ZakatWorksheet {...props} canEdit={false} canSubmit={false} canCreateOwnership={false} canCreateAdjustment={false} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.getByText('Balances and classification')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Add eligibility record' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Add adjustment' })).toBeNull();
  });
});
