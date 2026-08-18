import { describe, expect, it } from 'vitest';
import { buildVatWorkingPaperXlsx, loadVatClosingReport, VatReportOpenPeriodError } from '../src/modules/vat/vat-report';

const companyId='11111111-1111-4111-8111-111111111111';
const periodId='22222222-2222-4222-8222-222222222222';

type QueryCall={sql:string;params:unknown[]};
function dbWith(status:'open'|'closed'){
  let call=0;
  const calls:QueryCall[]=[];
  const db={query: async(sql:string,params:unknown[]=[])=>{
    calls.push({sql,params});
    call++;
    if(call===1)return {rows:[{id:periodId,period_start:'2026-01-01',period_end:'2026-03-31',status,company_name:'Test Company'}]};
    return {rows:[{id:'33333333-3333-4333-8333-333333333333',original_filename:'sale.pdf',document_type:'sale',document_date:'2026-02-01',counterparty_name:'Customer A',total_amount:'115.00',tax_date:'2026-02-01',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00'},{id:'44444444-4444-4444-8444-444444444444',original_filename:'purchase.pdf',document_type:'purchase',document_date:'2026-02-02',counterparty_name:'Supplier B',total_amount:'57.50',tax_date:'2026-02-02',treatment:'standard',taxable_amount:'50.00',vat_amount:'7.50'}]};
  }} as any;
  return {db,calls};
}

describe('VAT closing report',()=>{
  it('rejects an open period',async()=>{
    const {db}=dbWith('open');
    await expect(loadVatClosingReport(db,companyId,periodId)).rejects.toBeInstanceOf(VatReportOpenPeriodError);
  });

  it('builds tenant-scoped totals from reviewed documents',async()=>{
    const {db,calls}=dbWith('closed');
    const report=await loadVatClosingReport(db,companyId,periodId);
    expect(calls[0]?.params).toEqual([periodId,companyId]);
    expect(calls[1]?.params).toEqual([companyId,'2026-01-01','2026-03-31']);
    expect(calls[0]?.sql).toContain('vp.company_id=$2');
    expect(calls[1]?.sql).toContain('d.company_id=$1');
    expect(report.company).toEqual({id:companyId,name:'Test Company'});
    expect(report.totals).toEqual({output_vat:15,input_vat:7.5,net_vat:7.5,sales_total:115,purchase_expense_total:57.5});
    expect(report.treatments.standard).toEqual({count:2,taxable_amount:150,vat_amount:22.5});
    expect(report.documents.map(d=>d.counterparty_name)).toEqual(['Customer A','Supplier B']);
  });

  it('creates a real xlsx zip package',async()=>{
    const {db}=dbWith('closed');
    const report=await loadVatClosingReport(db,companyId,periodId);
    const xlsx=buildVatWorkingPaperXlsx(report);
    expect(xlsx.subarray(0,4).toString('hex')).toBe('504b0304');
    expect(xlsx.includes(Buffer.from('VAT Working Paper'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Customer A'))).toBe(true);
    expect(xlsx.includes(Buffer.from('[Content_Types].xml'))).toBe(true);
    expect(xlsx.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);
  });
});
