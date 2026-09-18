import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

const readiness={
  fiscal_year:{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'},
  ready:true,blocker_count:0,
  financial_statements_readiness:{status:'ready',label:'Ready',label_ar:'جاهز'},
  zakat_readiness:{status:'ready'},domains:{},package_manifest:[],
};

const mockAnnualClosingFetch=(packageValue:unknown)=>vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init)=>{
  const url=String(input);
  if(init?.method==='POST') return new Response(JSON.stringify({package:packageValue}),{status:200});
  if(url==='/api/fiscal-years') return new Response(JSON.stringify({fiscalYears:[{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'}]}),{status:200});
  if(url==='/api/annual-closing/fy-1/package') return new Response(JSON.stringify({package:packageValue,live:packageValue?{manifest:[],source_fingerprint:'x'}:null,drift:false}),{status:200});
  if(url==='/api/annual-closing/fy-1') return new Response(JSON.stringify(readiness),{status:200});
  throw new Error(`Unexpected fetch: ${url}`);

});

describe('Annual Close Package granular capabilities',()=>{
  beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en');});

  it('does not expose package creation without create capability',async()=>{
    mockAnnualClosingFetch(null);
    render(<AnnualClosing canView canViewPackage canCreatePackage={false} canCreatePackageSnapshot={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByText('No annual package has been created.')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Create package'})).not.toBeInTheDocument();
  });

  it('keeps preview snapshot permission independent from finalize',async()=>{
    mockAnnualClosingFetch({id:'p',status:'draft',version:1,final_snapshot_id:null,finalized_at:null,handed_off_at:null,handoff_note:null,handoff_reference:null,snapshots:[]});
    render(<AnnualClosing canView canViewPackage canCreatePackage={false} canCreatePackageSnapshot canFinalizePackage={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('button',{name:'Create preview snapshot'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Finalize package'})).not.toBeInTheDocument();
  });

  it('gates professional review independently by lifecycle and capability',async()=>{
    mockAnnualClosingFetch({id:'p',status:'handed_off',version:3,final_snapshot_id:'s',finalized_at:'2026-01-01',handed_off_at:'2026-01-02',handoff_note:null,handoff_reference:null,reviewed_at:null,review_note:null,approved_at:null,approval_note:null,snapshots:[]});
    render(<AnnualClosing canView canViewPackage canReviewPackage canApprovePackage={false} onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('button',{name:'Record professional review'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Record professional approval'})).not.toBeInTheDocument();
  });

  it('gates professional approval independently by lifecycle and capability',async()=>{
    mockAnnualClosingFetch({id:'p',status:'reviewed',version:4,final_snapshot_id:'s',finalized_at:'2026-01-01',handed_off_at:'2026-01-02',handoff_note:null,handoff_reference:null,reviewed_by_user_id:'reviewer',reviewed_at:'2026-01-03',review_note:'Checked',approved_at:null,approval_note:null,snapshots:[]});
    render(<AnnualClosing canView canViewPackage canReviewPackage={false} canApprovePackage onUnauthorized={vi.fn()}/>);
    expect(await screen.findByRole('button',{name:'Record professional approval'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Record professional review'})).not.toBeInTheDocument();
    expect(screen.getByText(/Professionally reviewed by reviewer/)).toBeInTheDocument();
  });

  it('uses an in-app review dialog, cancels without mutation, and confirms with the optional note',async()=>{
    const prompt=vi.spyOn(window,'prompt');
    const fetchMock=mockAnnualClosingFetch({id:'p',status:'handed_off',version:3,final_snapshot_id:'s',finalized_at:'2026-01-01',handed_off_at:'2026-01-02',handoff_note:null,handoff_reference:null,reviewed_at:null,review_note:null,approved_at:null,approval_note:null,snapshots:[]});
    render(<AnnualClosing canView canViewPackage canReviewPackage onUnauthorized={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Record professional review'}));
    expect(screen.getByRole('dialog',{name:'Professional review'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    expect(fetchMock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button',{name:'Record professional review'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Note (optional)'}),{target:{value:'  Reviewed against final snapshot  '}});
    fireEvent.click(screen.getByRole('button',{name:'Confirm review'}));
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/annual-closing/fy-1/package/review',expect.objectContaining({method:'POST',body:JSON.stringify({version:3,note:'Reviewed against final snapshot'})})));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('renders the Arabic approval dialog labels without raw translation keys',async()=>{
    await i18n.changeLanguage('ar');
    const fetchMock=mockAnnualClosingFetch({id:'p',status:'reviewed',version:4,final_snapshot_id:'s',finalized_at:'2026-01-01',handed_off_at:'2026-01-02',handoff_note:null,handoff_reference:null,reviewed_by_user_id:'reviewer',reviewed_at:'2026-01-03',review_note:null,approved_at:null,approval_note:null,snapshots:[]});
    render(<AnnualClosing canView canViewPackage canApprovePackage onUnauthorized={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:'تسجيل الاعتماد المهني'}));
    expect(screen.getByRole('dialog',{name:'تسجيل الاعتماد المهني'})).toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:'ملاحظة (اختيارية)'})).toHaveAttribute('maxlength','2000');
    expect(screen.getByRole('button',{name:'إلغاء'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'تأكيد الاعتماد'})).toBeInTheDocument();
    expect(screen.queryByText(/annualClosing\.package\./)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'تأكيد الاعتماد'}));
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/annual-closing/fy-1/package/approve',expect.objectContaining({method:'POST',body:JSON.stringify({version:4,note:null})})));
  });

});
