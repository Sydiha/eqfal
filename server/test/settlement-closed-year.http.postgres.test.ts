import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Closed fiscal year on the settlement routes (obligation settlement and document allocation) over real HTTP + PostgreSQL (disposable DATABASE_URL only):
// 409 FISCAL_YEAR_CLOSED, nothing written; the same calls succeed in an open year; another company's user gets 404.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('settlements in a closed fiscal year (PostgreSQL, HTTP)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());
  let rowNo = 0;

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier','supplier',$2) RETURNING id", [id, owner.id]))[0]!.id;
    rowNo += 1;
    const tx = (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,'2026-03-05',-250,'SAR',$4,$5,'strong') RETURNING id",
      [id, bank, batch, rowNo, `fp-${randomUUID()}`]))[0]!.id;
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,250,'2026-01-20','confirmed','manual',$3) RETURNING id", [id, cp, owner.id]))[0]!.id;
    const docId = (await h.q<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount,counterparty_id) VALUES($1,$2,'p.pdf','application/pdf',10,$3,$4,'approved','purchase','2026-01-10',250,$5) RETURNING id",
      [id, owner.id, `d-${randomUUID()}`, 'b'.repeat(64), cp]))[0]!.id;
    return { id, fy, owner, tx, ob, docId };
  }
  type Co = Awaited<ReturnType<typeof setup>>;
  const closeYear = (co: Co) => h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]);
  const settle = (co: Co, client = co.owner.client) => client.req('POST', `/obligations/${co.ob}/settlements`, { bank_transaction_id: co.tx, amount: '250.00' });
  const allocate = (co: Co) => co.owner.client.req('POST', `/bank-transactions/${co.tx}/allocations`, { allocations: [{ document_id: co.docId, amount: '250.00' }] });
  const written = (co: Co) => h.count('SELECT (SELECT COUNT(*) FROM obligation_settlements WHERE company_id=$1)+(SELECT COUNT(*) FROM document_settlements WHERE company_id=$1) n', [co.id]);

  it('obligation settlement: 409 FISCAL_YEAR_CLOSED with nothing written; the open year still settles', async () => {
    const open = await setup('obopen');
    expect((await settle(open)).status).toBe(201);
    const co = await setup('obclosed');
    await closeYear(co);
    const res = await settle(co);
    expect([res.status, res.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect(await written(co)).toBe(0);
  });

  it('document allocation: 409 FISCAL_YEAR_CLOSED with nothing written; the open year still allocates', async () => {
    const open = await setup('dcopen');
    const ok = await allocate(open);
    expect(ok.status, JSON.stringify(ok.json)).toBeLessThan(300);
    const co = await setup('dcclosed');
    await closeYear(co);
    const res = await allocate(co);
    expect([res.status, res.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect(await written(co)).toBe(0);
  });

  it('another company cannot reach the settlement (404) and writes nothing', async () => {
    const co = await setup('isoa');
    const other = await setup('isob');
    await closeYear(co);
    expect((await settle(co, other.owner.client)).status).toBe(404);
    expect(await written(co)).toBe(0);
  });
});
