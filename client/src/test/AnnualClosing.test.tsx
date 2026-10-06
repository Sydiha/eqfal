import { fireEvent, screen, waitFor, within } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

const openPackageTab=async()=>fireEvent.click(await screen.findByRole('tab',{name:/closing package|حزمة الإقفال/i}));
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
  it.each([
    ['en', 'Withholding Tax', 'Withholding Tax Readiness'],
    ['ar', 'ضريبة الاستقطاع', 'جاهزية ضريبة الاستقطاع'],
  ])('renders translated WHT readiness labels in %s', async (language, domainLabel, manifestLabel) => {
    await i18n.changeLanguage(language);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: 'FY', start_date: '2025-01-01', end_date: '2025-12-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ready: true,
      blocker_count: 0,
      financial_statements_readiness: { status: 'ready', label: 'Financial statements readiness', label_ar: 'جاهزية القوائم المالية' },
      zakat_readiness: { status: 'ready' },
      domains: { wht: { ready: true, blocker_count: 0, status: 'ready', summary: {} } },
      package_manifest: [{ section: 'wht_readiness', status: 'ready', blocker_count: 0 }],
    }), { status: 200 }));

    const { container } = render(<AnnualClosing canView onUnauthorized={vi.fn()}/>);

    expect(await screen.findByText(domainLabel)).toBeInTheDocument();
    expect(screen.getByText(manifestLabel)).toBeInTheDocument();
    expect(container).not.toHaveTextContent('annualClosing.domainNames.wht');
    expect(container).not.toHaveTextContent('annualClosing.manifestNames.wht_readiness');
  });
  it('presents unresolved items and blocked financial domains in English', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: 'FY', start_date: '2025-01-01', end_date: '2025-12-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ready: false, blocker_count: 34,
      financial_statements_readiness: { status: 'blocked', label: 'Financial statements readiness', label_ar: 'جاهزية القوائم المالية' }, zakat_readiness: { status: 'ready' },
      domains: {
        monthly_close: { ready: false, blocker_count: 10, status: 'blocked', summary: {} }, ledger: { ready: false, blocker_count: 8, status: 'blocked', summary: {} },
        documents: { ready: false, blocker_count: 7, status: 'blocked', summary: {} }, assets: { ready: false, blocker_count: 4, status: 'blocked', summary: {} },
        adjustments: { ready: true, blocker_count: 0, status: 'ready', summary: {} }, opening_balances: { ready: true, blocker_count: 0, status: 'ready', summary: {} },
      },
      package_manifest: [{ section: 'financial_statements_readiness', status: 'blocked', blocker_count: 34 }],
    }), { status: 200 }));
    render(<AnnualClosing canView onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('Unresolved items: 34')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: 'Unresolved items' })).toHaveLength(2);
    const readinessRow = screen.getAllByText('Financial statements readiness').at(-1)?.closest('tr');
    expect(readinessRow).not.toBeNull();
    expect(within(readinessRow!).getByText('4 blocked domains')).toBeInTheDocument();
    expect(within(readinessRow!).queryByText('34')).not.toBeInTheDocument();
  });
  it('presents unresolved items and blocked financial domains in Arabic', async () => {
    await i18n.changeLanguage('ar');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: '2025', start_date: '2025-01-01', end_date: '2025-12-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ready: false, blocker_count: 34,
      financial_statements_readiness: { status: 'blocked', label: 'Financial statements readiness', label_ar: 'جاهزية القوائم المالية' }, zakat_readiness: { status: 'ready' },
      domains: {
        monthly_close: { ready: false, blocker_count: 10, status: 'blocked', summary: {} }, ledger: { ready: false, blocker_count: 8, status: 'blocked', summary: {} },
        documents: { ready: false, blocker_count: 7, status: 'blocked', summary: {} }, assets: { ready: false, blocker_count: 4, status: 'blocked', summary: {} },
        adjustments: { ready: true, blocker_count: 0, status: 'ready', summary: {} }, opening_balances: { ready: true, blocker_count: 0, status: 'ready', summary: {} },
      },
      package_manifest: [{ section: 'financial_statements_readiness', status: 'blocked', blocker_count: 34 }],
    }), { status: 200 }));
    render(<AnnualClosing canView onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('العناصر غير المحسومة: 34')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: 'العناصر غير المحسومة' })).toHaveLength(2);
    const readinessRow = screen.getAllByText('جاهزية القوائم المالية').at(-1)?.closest('tr');
    expect(readinessRow).not.toBeNull();
    expect(within(readinessRow!).getByText('4 مجالات متعثرة')).toBeInTheDocument();
    expect(within(readinessRow!).queryByText('34')).not.toBeInTheDocument();
    expect(screen.queryByText('العوائق الجوهرية')).not.toBeInTheDocument();
  });
  it('renders capability-sensitive package actions and internal-handoff wording',async()=>{const fetchMock=vi.spyOn(globalThis,'fetch');fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'Ready for financial statement preparation',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]}),{status:200}));fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[{section:'cash_flow',status:'ready',blocker_count:0,blockers:[],source:'financial-statements',summary:{}}],source_fingerprint:'x'},drift:false}),{status:200}));render(<AnnualClosing canView canViewPackage canCreatePackageSnapshot canFinalizePackage onUnauthorized={vi.fn()}/>);await openPackageTab();expect(await screen.findByRole('button',{name:'Create preview snapshot'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Finalize package'})).toBeInTheDocument();expect(screen.getByText(/not government or ZATCA filing/i)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Mark accountant handoff'})).not.toBeInTheDocument();});
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
    await openPackageTab();
    expect(await screen.findByRole('heading',{name:'حزمة الإقفال السنوي'})).toBeInTheDocument();
    expect(await screen.findByText('السنوات المالية')).toBeInTheDocument();
    expect(screen.getByText('القوائم المالية')).toBeInTheDocument();
    expect(container).toHaveTextContent('الإقفال الشهري غير جاهز');
    expect(container).toHaveTextContent('القوائم المالية غير جاهزة');
    expect(container).toHaveTextContent('توجد متطلبات غير مكتملة تحتاج إلى المراجعة');
    for(const technicalValue of [...sources,...blockers])expect(container).not.toHaveTextContent(technicalValue);
    expect(container).not.toHaveTextContent('حزمة الإقفال السنوي المحكومة');
  });
  it('shows failed finalization blockers in a styled Arabic warning list',async()=>{
    await i18n.changeLanguage('ar');
    const fetchMock=vi.spyOn(globalThis,'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'2025',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:false,blocker_count:2,financial_statements_readiness:{status:'blocked',label:'',label_ar:'جاهزية القوائم المالية'},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[],source_fingerprint:'x'},drift:false}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:'package_not_ready',blockers:['monthly_close:blocked','monthly_close:monthly_close_not_ready','cash_flow:blocked','cash_flow:cash_flow_not_ready']}),{status:409}));
    render(<AnnualClosing canView canViewPackage canFinalizePackage onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    fireEvent.click(await screen.findByRole('button',{name:'اعتماد الحزمة نهائياً'}));
    const warning=await screen.findByRole('alert');
    expect(warning).toHaveClass('warning-alert');
    expect(within(warning).getByText('تعذر اعتماد الحزمة نهائيًا')).toBeInTheDocument();
    expect(within(warning).getAllByRole('listitem')).toHaveLength(2);
    expect(within(warning).getByText('الإقفال الشهري غير جاهز')).toBeInTheDocument();
    expect(within(warning).getByText('قائمة التدفقات النقدية غير جاهزة')).toBeInTheDocument();
    expect(warning).not.toHaveTextContent('القسم متعثر');
    expect(warning).not.toHaveTextContent('Monthly close is not ready');
    expect(warning).not.toHaveTextContent('monthly_close_not_ready');
  });
  it('shows only English actionable blockers when finalization fails in English',async()=>{
    const fetchMock=vi.spyOn(globalThis,'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'2025',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:false,blocker_count:2,financial_statements_readiness:{status:'blocked',label:'Financial statement readiness',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[],source_fingerprint:'x'},drift:false}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:'package_not_ready',blockers:['monthly_close:blocked','monthly_close:monthly_close_not_ready','cash_flow:needs_review','cash_flow:cash_flow_not_ready']}),{status:409}));
    render(<AnnualClosing canView canViewPackage canFinalizePackage onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    fireEvent.click(await screen.findByRole('button',{name:'Finalize package'}));
    const warning=await screen.findByRole('alert');
    expect(within(warning).getByText('Package could not be finalized')).toBeInTheDocument();
    expect(within(warning).getAllByRole('listitem')).toHaveLength(2);
    expect(within(warning).getByText('Monthly close is not ready')).toBeInTheDocument();
    expect(within(warning).getByText('Cash Flow is not ready')).toBeInTheDocument();
    expect(warning).not.toHaveTextContent('Blocked');
    expect(warning).not.toHaveTextContent('الإقفال الشهري غير جاهز');
    expect(warning).not.toHaveTextContent('monthly_close_not_ready');
  });
  it('localizes Arabic snapshot types and formats package timestamps for people',async()=>{
    await i18n.changeLanguage('ar');
    const previewAt='2025-06-01T10:15:00.000Z';
    const finalAt='2025-06-02T11:30:00.000Z';
    const handoffAt='2025-06-03T12:45:00.000Z';
    const fetchMock=vi.spyOn(globalThis,'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'2025',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'',label_ar:'جاهزة'},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]}),{status:200}));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({package:{id:'p',status:'handed_off',version:3,final_snapshot_id:'s2',finalized_at:finalAt,handed_off_at:handoffAt,handoff_note:null,handoff_reference:null,snapshots:[{id:'s1',snapshot_no:1,snapshot_type:'preview',manifest:[],source_fingerprint:'a',created_at:previewAt},{id:'s2',snapshot_no:2,snapshot_type:'final',manifest:[],source_fingerprint:'b',created_at:finalAt}]},live:{manifest:[],source_fingerprint:'b'},drift:false}),{status:200}));
    const {container}=render(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    expect(await screen.findByText(/\(معاينة\)/)).toBeInTheDocument();
    expect(screen.getByText(/\(نهائية\)/)).toBeInTheDocument();
    for(const value of [previewAt,finalAt,handoffAt])expect(container).not.toHaveTextContent(value);
    const format=(value:string)=>new Intl.DateTimeFormat('ar',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
    expect(container).toHaveTextContent(format(previewAt));
    expect(container).toHaveTextContent(format(finalAt));
    expect(container).toHaveTextContent(format(handoffAt));
  });

  it('sends a package action once on repeated clicks and locks actions while in flight',async()=>{
    const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
    const readiness={ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]};
    const pkg={package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[],source_fingerprint:'x'},drift:false};
    let release:(r:Response)=>void=()=>undefined;
    const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
      const url=String(input);
      if(url==='/api/fiscal-years')return Promise.resolve(json({fiscalYears:[{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'}]}));
      if(init?.method==='POST')return new Promise<Response>(resolve=>{release=resolve;});
      return Promise.resolve(json(url.endsWith('/package')?pkg:readiness));
    });
    render(<AnnualClosing canView canViewPackage canCreatePackageSnapshot canFinalizePackage onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    const preview=await screen.findByRole('button',{name:'Create preview snapshot'});
    fireEvent.click(preview);fireEvent.click(preview);
    expect(fetchMock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
    expect(screen.getByRole('button',{name:'Create preview snapshot'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Finalize package'})).toBeDisabled();
    release(json({}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Create preview snapshot'})).toBeEnabled());
  });
  it('clears the previous year package immediately when another fiscal year is selected',async()=>{
    const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
    const readiness={ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]};
    const pkg={package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[],source_fingerprint:'x'},drift:false};
    vi.spyOn(globalThis,'fetch').mockImplementation(input=>{
      const url=String(input);
      if(url==='/api/fiscal-years')return Promise.resolve(json({fiscalYears:[{id:'fy-1',name:'FY1',start_date:'2025-01-01',end_date:'2025-12-31'},{id:'fy-2',name:'FY2',start_date:'2026-01-01',end_date:'2026-12-31'}]}));
      if(url==='/api/annual-closing/fy-2/package')return new Promise<Response>(()=>undefined);
      return Promise.resolve(json(url.endsWith('/package')?pkg:readiness));
    });
    render(<AnnualClosing canView canViewPackage canCreatePackageSnapshot onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    await screen.findByRole('button',{name:'Create preview snapshot'});
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'fy-2'}});
    expect(screen.queryByRole('button',{name:'Create preview snapshot'})).not.toBeInTheDocument();
  });

  it('reloads authoritative package state after a rejected mutation request',async()=>{
    const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
    const readiness={ready:true,blocker_count:0,financial_statements_readiness:{status:'ready',label:'',label_ar:''},zakat_readiness:{status:'ready'},domains:{},package_manifest:[]};
    const pkg={package:{id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]},live:{manifest:[],source_fingerprint:'x'},drift:false};
    const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
      const url=String(input);
      if(url==='/api/fiscal-years')return Promise.resolve(json({fiscalYears:[{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'}]}));
      if(init?.method==='POST')return Promise.reject(new TypeError('network'));
      return Promise.resolve(json(url.endsWith('/package')?pkg:readiness));
    });
    render(<AnnualClosing canView canViewPackage canCreatePackageSnapshot onUnauthorized={vi.fn()}/>);
    await openPackageTab();
    const packageGets=()=>fetchMock.mock.calls.filter(([u,init])=>String(u)==='/api/annual-closing/fy-1/package'&&init?.method!=='POST').length;
    fireEvent.click(await screen.findByRole('button',{name:'Create preview snapshot'}));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(()=>expect(packageGets()).toBe(2));
  });
});
