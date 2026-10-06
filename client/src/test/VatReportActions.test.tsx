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
});
