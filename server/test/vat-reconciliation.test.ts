import { describe, expect, it, vi } from 'vitest';
import { loadVatReconciliation, VatReconciliationDocument } from '../src/modules/vat/vat-reconciliation';

const COMPANY='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const START='2026-01-01',END='2026-03-31';

function detail(overrides:Partial<VatReconciliationDocument>={}):VatReconciliationDocument {
  return {document_id:'33333333-3333-4333-8333-333333333333',obligation_id:'44444444-4444-4444-8444-444444444444',document_type:'sale',tax_date:'2026-02-01',treatment:'standard',reviewed_vat_amount:'15.00',recoverability_status:'not_applicable',recoverable_vat_amount:null,non_recoverable_vat_amount:null,expected_vat_amount:'15.00',expected_memo:'VAT_OUTPUT',journal_entry_id:'55555555-5555-4555-8555-555555555555',journal_status:'posted',ledger_vat_amount:'15.00',reconciliation_status:'reconciled',...overrides};
}
function database(rows:VatReconciliationDocument[]){return{query:vi.fn(async()=>({rows,rowCount:rows.length}))} as any;}

describe('Phase 6B1 VAT reconciliation',()=>{
  it.each([
    ['sale output credit',detail()],
    ['purchase input debit',detail({document_type:'purchase',recoverability_status:'fully_recoverable',recoverable_vat_amount:'15.00',non_recoverable_vat_amount:'0.00',expected_vat_amount:'15.00',expected_memo:'VAT_INPUT'})],
    ['expense input debit',detail({document_type:'expense',recoverability_status:'fully_recoverable',recoverable_vat_amount:'15.00',non_recoverable_vat_amount:'0.00',expected_vat_amount:'15.00',expected_memo:'VAT_INPUT'})],
  ])('reconciles %s',async(_name,row)=>{
    const value=await loadVatReconciliation(database([row]),COMPANY,START,END);
    expect(value.counts).toEqual({total_in_scope:1,reconciled:1,unreconciled:0});
  });

  it.each([
    ['no journal','missing_posted_journal',null,null],
    ['draft journal','missing_posted_journal','55555555-5555-4555-8555-555555555555','draft'],
    ['missing memo','missing_vat_line','55555555-5555-4555-8555-555555555555','posted'],
    ['opposite VAT_INPUT/VAT_OUTPUT','wrong_vat_direction','55555555-5555-4555-8555-555555555555','posted'],
    ['wrong debit/credit direction','wrong_vat_direction','55555555-5555-4555-8555-555555555555','posted'],
    ['wrong amount','vat_amount_mismatch','55555555-5555-4555-8555-555555555555','posted'],
    ['multiple expected memo lines','vat_amount_mismatch','55555555-5555-4555-8555-555555555555','posted'],
  ] as const)('counts %s as unreconciled',async(_name,status,journalId,journalStatus)=>{
    const row=detail({journal_entry_id:journalId,journal_status:journalStatus,ledger_vat_amount:null,reconciliation_status:status});
    const value=await loadVatReconciliation(database([row]),COMPANY,START,END);
    expect(value.counts.unreconciled).toBe(1);
    expect(value.totals.ledger_output_vat).toBe(0);
    expect(value.totals.output_difference).toBe(15);
  });

  it.each(['standard','zero_rated','exempt','out_of_scope'] as const)('does not block zero VAT treatment %s',async treatment=>{
    const row=detail({treatment,reviewed_vat_amount:'0.00',journal_entry_id:null,journal_status:null,ledger_vat_amount:null});
    const value=await loadVatReconciliation(database([row]),COMPANY,START,END);
    expect(value.counts).toEqual({total_in_scope:1,reconciled:1,unreconciled:0});
  });

  it('calculates reviewed, ledger, and difference totals by direction',async()=>{
    const value=await loadVatReconciliation(database([
      detail({reviewed_vat_amount:'15.00',ledger_vat_amount:'15.00'}),
      detail({document_id:'66666666-6666-4666-8666-666666666666',document_type:'purchase',recoverability_status:'fully_recoverable',recoverable_vat_amount:'7.50',non_recoverable_vat_amount:'0.00',expected_vat_amount:'7.50',expected_memo:'VAT_INPUT',reviewed_vat_amount:'7.50',ledger_vat_amount:'7.50'}),
      detail({document_id:'77777777-7777-4777-8777-777777777777',reviewed_vat_amount:'2.00',ledger_vat_amount:'1.00',reconciliation_status:'vat_amount_mismatch'}),
    ]),COMPANY,START,END);
    expect(value.totals).toEqual({reviewed_output_vat:17,reviewed_input_vat:7.5,gross_reviewed_input_vat:7.5,recoverable_input_vat:7.5,non_recoverable_input_vat:0,ledger_output_vat:15,ledger_input_vat:7.5,output_difference:2,input_difference:0});
    expect(value.counts).toEqual({total_in_scope:3,reconciled:2,unreconciled:1});
  });

  it('uses tax date and tenant-scopes every reconciliation relation',async()=>{
    const db=database([]);
    await loadVatReconciliation(db,COMPANY,START,END);
    const [sql,params]=db.query.mock.calls[0];
    expect(params).toEqual([COMPANY,START,END]);
    expect(sql).toContain('r.tax_date BETWEEN $2 AND $3');
    expect(sql).not.toContain('d.document_date BETWEEN');
    expect(sql).toContain('d.company_id=$1');
    expect(sql).toContain('r.company_id=d.company_id');
    expect(sql).toContain('o.company_id=d.company_id');
    expect(sql).toContain('j.company_id=$1');
    expect(sql).toContain('l.company_id=$1');
  });

  it('limits scope to confirmed, active document obligations and obligation journals',async()=>{
    const db=database([]);
    await loadVatReconciliation(db,OTHER,START,END);
    const sql=db.query.mock.calls[0][0] as string;
    expect(sql).toContain("o.source_type='document'");
    expect(sql).toContain('NOT o.is_cancelled');
    expect(sql).toContain("o.verification_status='confirmed'");
    expect(sql).toContain("j.source_type='obligation'");
    expect(sql).toContain("j.source_id=s.obligation_id");
    expect(sql).not.toContain('custody');
  });

  it('performs exact NUMERIC comparison and rejects duplicate expected memo lines',async()=>{
    const db=database([]);
    await loadVatReconciliation(db,COMPANY,START,END);
    const sql=db.query.mock.calls[0][0] as string;
    expect(sql).toContain('ledger_vat_amount::numeric<>expected_vat_amount');
    expect(sql).toContain('WHEN expected_line_count>1');
    expect(sql).toContain("l.memo=s.expected_memo");
  });
});
