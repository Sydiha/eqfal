import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql=readFileSync(new URL('../migrations/014_document_settlements.sql',import.meta.url),'utf8');

describe('Migration 014 settlement integrity',()=>{
  it('keeps settlement capability and one-bank-transaction constraint',()=>{
    expect(sql).toContain("VALUES ('payment.settle')");
    expect(sql).toMatch(/UNIQUE \(bank_transaction_id\)/);
  });

  it('enforces same-company document, transaction, and match relationships',()=>{
    expect(sql).toMatch(/FOREIGN KEY \(document_id, company_id\)[\s\S]*REFERENCES documents\(id, company_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(bank_transaction_id, company_id\)[\s\S]*REFERENCES bank_transactions\(id, company_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(bank_transaction_id, company_id, document_id\)[\s\S]*REFERENCES bank_transaction_matches\(bank_transaction_id, company_id, document_id\)/);
    expect(sql).toMatch(/UNIQUE \(bank_transaction_id, company_id, document_id\)/);
  });
});
