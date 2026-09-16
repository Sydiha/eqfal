import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

describe('Annual Closing Center', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });
  it('is capability gated', () => { render(<AnnualClosing canView={false} onUnauthorized={vi.fn()}/>); expect(screen.getByText(/permission to view annual closing/i)).toBeInTheDocument(); });
  it('loads a fiscal-year keyed readiness view and renders domains and manifest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: 'FY', start_date: '2025-04-01', end_date: '2026-03-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ready: false, blocker_count: 1, financial_statements_readiness: { status: 'needs_review', label: 'Ready for financial statement preparation', label_ar: 'جاهز لإعداد القوائم المالية' }, zakat_readiness: { status: 'needs_review' }, domains: { monthly_close: { ready: false, blocker_count: 1, status: 'blocked', summary: {} } }, package_manifest: [{ section: 'fiscal_year', status: 'ready' }] }), { status: 200 }));
    render(<AnnualClosing canView onUnauthorized={vi.fn()}/>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/annual-closing/fy-1'));
    expect(await screen.findByText('Not ready')).toBeInTheDocument(); expect(screen.getByText('Monthly close')).toBeInTheDocument(); expect(screen.getByText('Annual Closing Package manifest')).toBeInTheDocument();
  });
  it('renders capability-sensitive package actions and internal-handoff wording',async()=>{const fetchMock=vi.spyOn(globalThis,'fetch');fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'Ready for financial statement preparation',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]}),{status:200}));fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[{section:'cash_flow',status:'ready',blocker_count:0,blockers:[],source:'financial-statements',summary:{}}],source_fingerprint:'x'},drift:false}),{status:200}));render(<AnnualClosing canView canViewPackage canManagePackage canFinalizePackage onUnauthorized={vi.fn()}/>);expect(await screen.findByRole('button',{name:'Create preview snapshot'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Finalize package'})).toBeInTheDocument();expect(screen.getByText(/not government or ZATCA filing/i)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Mark accountant handoff'})).not.toBeInTheDocument();});
  it('renders friendly Arabic package sources and blocker messages without technical identifiers',async()=>{
    await i18n.changeLanguage('ar');
    const sources=['fiscal-years','monthly-close','accounting','financial-statements','tax-working-papers','vat','banking','obligations','documents','partners','fixed-assets','periodic-adjustments','opening-balances'];
    const blockers=['monthly_close_not_ready','trial_balance_not_ready','general_ledger_not_ready','statement_of_financial_position_not_ready','profit_or_loss_not_ready','changes_in_equity_not_ready','cash_flow_not_ready','financial_statements_not_ready','vat_periods_returns_not_ready','fixed_assets_depreciation_not_ready','periodic_adjustments_not_ready','unknown_internal_code'];
    const sections=['fiscal_year','monthly_close','trial_balance','general_ledger','statement_of_financial_position','profit_or_loss','changes_in_equity','cash_flow','tax_zakat_working_paper','vat_periods_returns','bank_reconciliation','receivables_payables','document_exceptions'];
    const manifest=sources.map((source,index)=>({section:sections[index],status:'blocked',blocker_count:index===0?blockers.length:0,blockers:index===0?blockers:[],source,summary:{}}));
    const fetchMock=vi.spyOn(globalThis,'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'2025',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:false,blocker_count:1,financial_statements_readiness:{status:'needs_review',label:'',label_ar:'جاهزية القوائم المالية'},zakat_readiness:{status:'needs_review'},domains:{},package_manifest:[]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest,source_fingerprint:'x'},drift:false}),{status:200}));
    const {container}=render(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('heading',{name:'حزمة الإقفال السنوي'})).toBeInTheDocument();
    expect(await screen.findByText('السنوات المالية')).toBeInTheDocument();
    expect(screen.getByText('القوائم المالية')).toBeInTheDocument();
    expect(container).toHaveTextContent('الإقفال الشهري غير جاهز');
    expect(container).toHaveTextContent('القوائم المالية غير جاهزة');
    expect(container).toHaveTextContent('توجد متطلبات غير مكتملة تحتاج إلى المراجعة');
    for(const technicalValue of [...sources,...blockers])expect(container).not.toHaveTextContent(technicalValue);
    expect(container).not.toHaveTextContent('حزمة الإقفال السنوي المحكومة');
  });
});
