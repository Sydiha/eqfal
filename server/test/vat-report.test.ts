import { describe, expect, it } from 'vitest';
import { buildVatWorkingPaperXlsx, loadVatClosingReport, VatReportOpenPeriodError } from '../src/modules/vat/vat-report';

const companyId='11111111-1111-4111-8111-111111111111';
const periodId='22222222-2222-4222-8222-222222222222';

type QueryCall={sql:string;params:unknown[]};
function dbWith(status:'open'|'closed',adjustments:unknown[]=[]){
  let call=0;
  const calls:QueryCall[]=[];
  const db={query: async(sql:string,params:unknown[]=[])=>{
    calls.push({sql,params});
    call++;
    if(call===1)return {rows:[{id:periodId,period_start:'2026-01-01',period_end:'2026-03-31',status,company_name:'Test Company'}]};
    if(call===2)return {rows:[{id:'33333333-3333-4333-8333-333333333333',original_filename:'sale.pdf',document_type:'sale',document_date:'2026-02-01',counterparty_name:'Customer A',total_amount:'115.00',tax_date:'2026-02-01',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',recoverability_status:'not_applicable',recoverable_vat_amount:null,non_recoverable_vat_amount:null,recoverability_reason:null,recoverability_reviewed_by_user_id:null,recoverability_reviewed_at:null},{id:'44444444-4444-4444-8444-444444444444',original_filename:'purchase.pdf',document_type:'purchase',document_date:'2026-02-02',counterparty_name:'Supplier B',total_amount:'57.50',tax_date:'2026-02-02',treatment:'standard',taxable_amount:'50.00',vat_amount:'7.50',recoverability_status:'partially_recoverable',recoverable_vat_amount:'5.00',non_recoverable_vat_amount:'2.50',recoverability_reason:'Evidence supports partial recovery',recoverability_reviewed_by_user_id:'77777777-7777-4777-8777-777777777777',recoverability_reviewed_at:'2026-02-03T00:00:00Z'}]};
    if(call===3)return {rows:[{document_id:'33333333-3333-4333-8333-333333333333',obligation_id:'55555555-5555-4555-8555-555555555555',document_type:'sale',tax_date:'2026-02-01',treatment:'standard',reviewed_vat_amount:'15.00',expected_memo:'VAT_OUTPUT',journal_entry_id:'66666666-6666-4666-8666-666666666666',journal_status:'posted',ledger_vat_amount:'15.00',reconciliation_status:'reconciled'}]};
    if(call===4)return {rows:adjustments};
    return {rows:[]};
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
    expect(calls[2]?.params).toEqual([companyId,'2026-01-01','2026-03-31']);
    expect(calls[0]?.sql).toContain('vp.company_id=$2');
    expect(calls[1]?.sql).toContain('d.company_id=$1');
    expect(calls[1]?.sql).toContain('r.tax_date BETWEEN $2 AND $3');
    expect(calls[1]?.sql).not.toContain('d.document_date BETWEEN');
    expect(report.company).toEqual({id:companyId,name:'Test Company'});
    expect(report.totals).toEqual({output_vat:15,input_vat:7.5,net_vat:7.5,sales_total:115,purchase_expense_total:57.5,gross_reviewed_input_vat:7.5,recoverable_input_vat:5,non_recoverable_input_vat:2.5,recoverability_needs_review:0,fully_recoverable_documents:0,partially_recoverable_documents:1,non_recoverable_documents:0});
    expect(report.treatments.standard).toEqual({count:2,taxable_amount:150,vat_amount:22.5});
    expect(report.documents.map(d=>d.counterparty_name)).toEqual(['Customer A','Supplier B']);
    expect(report.reconciliation.counts).toEqual({total_in_scope:1,reconciled:1,unreconciled:0});
    expect(report.documents[0]).toMatchObject({expected_memo:'VAT_OUTPUT',reconciliation_status:'reconciled'});
    expect(report.documents[1]?.reconciliation_status).toBeUndefined();
  });

  it('creates a real xlsx zip package with readable labels',async()=>{
    const {db}=dbWith('closed');
    const report=await loadVatClosingReport(db,companyId,periodId);
    const xlsx=buildVatWorkingPaperXlsx(report);
    expect(xlsx.subarray(0,4).toString('hex')).toBe('504b0304');
    expect(xlsx.includes(Buffer.from('VAT Working Paper'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Customer A'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Purchase'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Standard'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Closed'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Reviewed Output VAT'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Reconciliation Status'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Gross Reviewed Input VAT'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Recoverability Review Pending'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Recoverability Status'))).toBe(true);
    expect(xlsx.includes(Buffer.from('Non-Recoverable VAT Amount'))).toBe(true);
    expect(xlsx.includes(Buffer.from('VAT_OUTPUT'))).toBe(true);
    expect(xlsx.includes(Buffer.from('[Content_Types].xml'))).toBe(true);
    expect(xlsx.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);
  });

  it('classifies applied output and input adjustments and calculates final net VAT',async()=>{
    const {db}=dbWith('closed',[
      {id:'a1',document_vat_review_id:'r1',document_type:'sale',original_vat_period_id:'p0',adjustment_vat_period_id:periodId,adjustment_type:'amount_correction',reason:'Sale correction',taxable_amount_delta:'10.00',vat_amount_delta:'1.50',recoverable_vat_amount_delta:'0.00',status:'applied',created_by_user_id:'u1',reviewed_by_user_id:'u2',reviewed_at:'2026-04-01'},
      {id:'a2',document_vat_review_id:'r2',document_type:'purchase',original_vat_period_id:'p0',adjustment_vat_period_id:periodId,adjustment_type:'recoverability_correction',reason:'Input correction',taxable_amount_delta:'2.00',vat_amount_delta:'2.00',recoverable_vat_amount_delta:'1.25',status:'applied',created_by_user_id:'u1',reviewed_by_user_id:'u2',reviewed_at:'2026-04-01'},
      {id:'a3',document_vat_review_id:'r3',document_type:'sale',original_vat_period_id:'p0',adjustment_vat_period_id:periodId,adjustment_type:'other',reason:'Not applied',taxable_amount_delta:'1.00',vat_amount_delta:'9.00',recoverable_vat_amount_delta:'0.00',status:'draft',created_by_user_id:'u1',reviewed_by_user_id:null,reviewed_at:null},
    ]);
    const report=await loadVatClosingReport(db,companyId,periodId);
    expect(report.totals).toMatchObject({output_vat_adjustments:1.5,gross_input_vat_adjustments:2,recoverable_input_vat_adjustments:1.25,final_output_vat:16.5,final_recoverable_input_vat:6.25,base_net_vat:10,net_adjustment_effect:.25,final_net_vat:10.25});
  });
});
