import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VatReportActions } from '../components/VatReportActions';

const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('VatReportActions Excel download',()=>{
  it('downloads the file via fetch and does not navigate on server error',async()=>{
    const onError=vi.fn();
    const assign=vi.fn();
    vi.stubGlobal('location',{...window.location,assign});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'VAT period must be closed'}),{status:409,headers:{'content-type':'application/json'}})));
    render(<VatReportActions periodId="p1" language="en" onError={onError}/>);
    fireEvent.click(screen.getByRole('button',{name:'Download Excel'}));
    await waitFor(()=>expect(onError).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Download Excel'})).not.toBeDisabled();
  });

  it('saves the spreadsheet with the server filename and ignores repeated clicks while busy',async()=>{
    const onError=vi.fn();
    let resolve!:(r:Response)=>void;
    const fetchMock=vi.fn().mockReturnValue(new Promise<Response>(r=>{resolve=r;}));
    vi.stubGlobal('fetch',fetchMock);
    URL.createObjectURL=vi.fn(()=>'blob:x');URL.revokeObjectURL=vi.fn();
    const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){expect(this.download).toBe('vat-working-paper-2026-01-01-2026-01-31.xlsx');});
    render(<VatReportActions periodId="p1" language="en" onError={onError}/>);
    const button=screen.getByRole('button',{name:'Download Excel'});
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/vat-periods/p1/working-paper.xlsx');
    resolve(new Response(new Blob(['x']),{status:200,headers:{'content-type':XLSX,'content-disposition':'attachment; filename="vat-working-paper-2026-01-01-2026-01-31.xlsx"'}}));
    await waitFor(()=>expect(click).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it('prints a report with grouped amounts, Gregorian date and a dash for a missing total',async()=>{
    const write=vi.fn();
    vi.stubGlobal('open',vi.fn(()=>({document:{write,close:vi.fn()},close:vi.fn()})));
    const report={company:{name:'Co'},period:{period_start:'2026-01-01',period_end:'2026-01-31',status:'closed'},totals:{output_vat:1500.5,input_vat:0,net_vat:1500.5,sales_total:0,purchase_expense_total:0},treatments:{},documents:[{original_filename:'a.pdf',counterparty_name:null,document_type:'sale',document_date:null,tax_date:'2026-01-02',treatment:'standard',total_amount:null,taxable_amount:'10000',vat_amount:'1500'}]};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(report),{status:200})));
    render(<VatReportActions periodId="p1" language="ar" onError={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:'تقرير إقفال الضريبة'}));
    await waitFor(()=>expect(write).toHaveBeenCalled());
    const html=write.mock.calls[0][0] as string;
    expect(html).toContain('lang="ar"');
    expect(html).toContain('1,500.50');
    expect(html).toContain('10,000.00');
    expect(html).toContain('<td class="n">—</td>');
  });
});
