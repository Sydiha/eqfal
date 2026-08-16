import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../migrations/013_bank_transaction_reconciliation.sql', import.meta.url), 'utf8');

describe('Phase 3B reconciliation migration', () => {
  it('declares composite unique keys required by company-scoped foreign keys', () => {
    expect(sql).toContain('documents_id_company_uidx UNIQUE (id, company_id)');
    expect(sql).toContain('bank_transactions_id_company_uidx UNIQUE (id, company_id)');
    expect(sql).toContain('FOREIGN KEY (bank_transaction_id, company_id)');
    expect(sql).toContain('REFERENCES bank_transactions(id, company_id)');
    expect(sql).toContain('FOREIGN KEY (document_id, company_id)');
    expect(sql).toContain('REFERENCES documents(id, company_id)');
  });
});
