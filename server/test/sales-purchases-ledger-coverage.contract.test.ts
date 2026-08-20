import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const obligations=readFileSync(new URL('../src/modules/obligations/obligation.router.ts',import.meta.url),'utf8');
const custody=readFileSync(new URL('../src/modules/banking/custody.router.ts',import.meta.url),'utf8');
const close=readFileSync(new URL('../src/modules/monthly-close/monthly-close.router.ts',import.meta.url),'utf8');
const sources=readFileSync(new URL('../src/modules/accounting/operational-sources.ts',import.meta.url),'utf8');

describe('sales and purchases ledger coverage contract',()=>{
  it('enforces document direction, economic date, amount, approval, counterparty and tenant identity',()=>{
    expect(obligations).toContain("d.document_type==='sale'?'receivable'");
    expect(obligations).toContain("d.document_type==='purchase'||d.document_type==='expense'?'payable'");
    expect(obligations).toContain('b.recognized_on!==d.document_date');
    expect(obligations).toContain("d.status!=='approved'");
    expect(obligations).toContain('cents(d.total_amount)!==cents(String(b.original_amount))');
    expect(obligations).toContain('WHERE id=$1 AND company_id=$2 FOR UPDATE');
  });

  it('preserves manual and opening balance paths while making obligation and custody recognition mutually exclusive',()=>{
    expect(obligations).toContain("b.source_type==='opening_balance'");
    expect(obligations).toContain('FROM custody_document_allocations WHERE document_id=$1 AND company_id=$2');
    expect(custody).toContain("FROM obligations WHERE document_id=$1 AND company_id=$2 AND source_type='document'");
    expect(custody).toContain("doc.document_type!=='expense'");
  });

  it('blocks approved material documents without the one valid posted recognition path and deduplicates by document',()=>{
    expect(close).toContain("d.document_type IN ('sale','purchase','expense')");
    expect(close).toContain("j.source_type='obligation'");
    expect(close).toContain("j.source_type='custody_allocation'");
    expect(close).toContain('SUM(a.amount)=m.total_amount');
    expect(close).toContain('return new Set(rows.map(row=>row.id))');
    expect(close).toContain('incompleteDocuments.size+unpostedSources+independentDrafts');
  });

  it('does not treat a document match or reconciliation status as accounting completion',()=>{
    expect(close).toContain("m.match_type='document'");
    expect(close).toContain('JOIN document_settlements s');
    expect(close).toContain("status='posted'");
    expect(close).not.toMatch(/reconciliation_status[^\n]+bank_transactions/);
  });

  it('requires exact VAT tags, side, account type and aggregate amount while permitting zero VAT',()=>{
    expect(close).toContain("l.memo='VAT_OUTPUT'");
    expect(close).toContain("l.memo='VAT_INPUT'");
    expect(close).toContain("a.account_type='liability'");
    expect(close).toContain("a.account_type='asset'");
    expect(close).toContain('v.vat_covered<>r.vat_amount');
    expect(close).toContain("r.vat_amount>0");
    expect(close).not.toContain('ILIKE');
  });

  it('keeps the authoritative operational source set and exposes document identity only as context',()=>{
    for(const type of ['obligation','document_settlement','obligation_settlement','custody_allocation','custody_funding','custody_return'])expect(sources).toContain(`'${type}'`);
    expect(sources).not.toMatch(/OPERATIONAL_SOURCE_TYPES=.*'document'/);
    expect(sources).toContain("'document_id',o.document_id");
  });
});
