import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

const readiness={
  fiscal_year:{id:'fy-1',name:'FY',start_date:'2025-01-01',end_date:'2025-12-31'},
  ready:true,blocker_count:0,
  financial_statements_readiness:{status:'ready',label:'Ready',label_ar:'جاهز'},
  zakat_readiness:{status:'ready'},domains:{},package_manifest:[],
};

const mockAnnualClosingFetch=(packageValue:unknown)=>vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
  const url=String(input);
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
});
