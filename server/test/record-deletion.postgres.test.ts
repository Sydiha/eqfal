import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DocumentFileCleanup } from '../src/modules/documents/document-file-cleanup';
import { RecordDeletionService } from '../src/modules/record-deletion/record-deletion.service';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// Delete & Void Phase 3 against a real, disposable PostgreSQL (DATABASE_URL). Skipped without it.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('record deletion (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const A = randomUUID(); const B = randomUUID(); const user = randomUUID();
  const removed: string[] = [];
  const files: StorageAdapter = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: vi.fn(async (k: string) => { removed.push(k); }) };
  const svc = new RecordDeletionService(pool, files);
  const fy: Record<string, string> = {}; const acc: Record<string, string[]> = {};
  const auditIds: string[] = [];
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as T[];
  const count = async (sql: string, p: unknown[]) => Number((await q<{ n: string }>(sql, p))[0]!.n);

  beforeAll(async () => {
    await q(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'test-only')`, [user, `recdel-${user}@example.test`]);
    for (const id of [A, B]) {
      await q(`INSERT INTO companies (id, slug, name) VALUES ($1,$2,'Rec delete')`, [id, `recdel-${id}`]);
      fy[id] = (await q<{ id: string }>(`INSERT INTO fiscal_years (company_id,name,start_date,end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0]!.id;
      acc[id] = [];
      for (const [i, t] of ['asset', 'revenue'].entries()) acc[id]!.push((await q<{ id: string }>(`INSERT INTO accounts (company_id,code,name,account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [id, `RD-${i}`, t]))[0]!.id);
    }
  });
  afterAll(async () => {
    const both = [A, B];
    await q('DELETE FROM storage_deletion_queue WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    await q('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM obligations WHERE company_id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM partner_ownership_periods WHERE company_id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM bank_import_batches WHERE company_id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM bank_accounts WHERE company_id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM periodic_adjustments WHERE company_id = ANY($1::uuid[])', [both]);
    await q('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_posted_immutable');
    await q('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_posted_immutable');
    await q('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [both]);
    await q('ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_posted_immutable');
    await q('ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_posted_immutable');
    await q('DELETE FROM monthly_close_periods WHERE company_id = ANY($1::uuid[])', [both]);
    for (const t of ['counterparties', 'partners', 'accounts', 'fiscal_years']) await q(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [both]);
    await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [both]);
    await q('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  async function journal(co: string, date = '2026-03-10', posted = false): Promise<string> {
    const id = (await q<{ id: string }>(`INSERT INTO journal_entries (company_id,fiscal_year_id,accounting_date,description,created_by) VALUES ($1,$2,$3,'manual',$4) RETURNING id`, [co, fy[co], date, user]))[0]!.id;
    await q(`INSERT INTO journal_lines (company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES ($1,$2,$3,100,0,1),($1,$2,$4,0,100,2)`, [co, id, acc[co]![0], acc[co]![1]]);
    if (posted) await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [id, user]);
    return id;
  }

  it('deletes a manual draft journal with its lines and writes a pre-delete audit snapshot', async () => {
    const id = await journal(A); auditIds.push(id);
    await svc.deleteJournal(A, user, id);
    expect(await count('SELECT count(*) n FROM journal_entries WHERE id=$1', [id])).toBe(0);
    expect(await count('SELECT count(*) n FROM journal_lines WHERE journal_entry_id=$1', [id])).toBe(0);
    const audit = (await q<{ before_data: { lines: unknown[] } }>(`SELECT before_data FROM audit_log WHERE entity_id=$1 AND action='journal.delete'`, [id]))[0]!;
    expect(audit.before_data.lines).toHaveLength(2);
  });
  it('never deletes a posted journal, a system-generated draft, another company\'s journal, or one in a closed period', async () => {
    const posted = await journal(A, '2026-03-11', true);
    await expect(svc.deleteJournal(A, user, posted)).rejects.toMatchObject({ reason: 'posted' });
    const system = await journal(A);
    await q(`UPDATE journal_entries SET source_type='invoice', source_id=$2 WHERE id=$1`, [system, randomUUID()]);
    await expect(svc.deleteJournal(A, user, system)).rejects.toMatchObject({ reason: 'system_generated' });
    const other = await journal(B);
    await expect(svc.deleteJournal(A, user, other)).rejects.toThrow();
    expect(await count('SELECT count(*) n FROM journal_entries WHERE id=ANY($1::uuid[])', [[posted, system, other]])).toBe(3);
    const closedDay = await journal(A, '2026-06-15');
    await q(`INSERT INTO monthly_close_periods (company_id,fiscal_year_id,period_start,period_end,status) VALUES ($1,$2,'2026-06-01','2026-06-30','closed')`, [A, fy[A]]);
    expect(await count(`SELECT count(*) n FROM monthly_close_periods WHERE company_id=$1 AND period_start='2026-06-01' AND status='closed'`, [A])).toBe(1);
    await expect(svc.deleteJournal(A, user, closedDay)).rejects.toThrow();
    expect(await count('SELECT count(*) n FROM journal_entries WHERE id=$1', [closedDay])).toBe(1);
  });
  it('journal: concurrent deletes of the same draft - exactly one succeeds', async () => {
    const id = await journal(A);
    const results = await Promise.allSettled([svc.deleteJournal(A, user, id), svc.deleteJournal(A, user, id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='journal.delete'`, [id])).toBe(1);
  });

  async function adjustment(co: string, status = 'draft'): Promise<string> {
    const extra = status === 'draft' ? '' : ', submitted_by_user_id, submitted_at';
    const vals = status === 'draft' ? '' : `, '${user}', NOW()`;
    return (await q<{ id: string }>(`INSERT INTO periodic_adjustments (company_id,adjustment_type,total_amount,recognition_start,recognition_end,description,balance_account_id,pnl_account_id,workflow_status,prepared_by_user_id${extra}) VALUES ($1,'prepaid_expense',120,'2026-02-01','2026-04-30','adj',$2,$3,$4,$5${vals}) RETURNING id`, [co, acc[co]![0], acc[co]![1], status, user]))[0]!.id;
  }
  it('periodic adjustment: deletes a draft only', async () => {
    const draft = await adjustment(A); const review = await adjustment(A, 'in_review');
    await expect(svc.deletePeriodicAdjustment(A, user, review)).rejects.toMatchObject({ reason: 'not_draft' });
    await expect(svc.deletePeriodicAdjustment(B, user, draft)).rejects.toThrow();
    await svc.deletePeriodicAdjustment(A, user, draft);
    expect(await count('SELECT count(*) n FROM periodic_adjustments WHERE id=ANY($1::uuid[])', [[draft, review]])).toBe(1);
  });

  async function batchRow(co: string, status: string, account: string) {
    const key = `${co}/${randomUUID()}`;
    return { key, id: (await q<{ id: string }>(`INSERT INTO bank_import_batches (company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES ($1,$2,'f.csv','text/csv','csv',$3,$3,$4,$5) RETURNING id`, [co, account, key, status, user]))[0]!.id };
  }
  it('bank import batch: unconfirmed batch is deleted and its file removed through the shared durable queue; confirmed one is kept', async () => {
    const account = (await q<{ id: string }>(`INSERT INTO bank_accounts (company_id,display_name,currency_code,created_by) VALUES ($1,'B','SAR',$2) RETURNING id`, [A, user]))[0]!.id;
    const open = await batchRow(A, 'preview_ready', account); const done = await batchRow(A, 'confirmed', account);
    await expect(svc.deleteBankImportBatch(A, user, done.id)).rejects.toMatchObject({ reason: 'confirmed' });
    await expect(svc.deleteBankImportBatch(B, user, open.id)).rejects.toThrow();
    expect(await svc.deleteBankImportBatch(A, user, open.id)).toEqual({ storage_cleanup: 'done' });
    expect(removed).toContain(open.key);
    expect(removed).not.toContain(done.key);
    expect(await count('SELECT count(*) n FROM bank_import_batches WHERE id=ANY($1::uuid[])', [[open.id, done.id]])).toBe(1);
    const queued = (await q<{ store: string; status: string }>('SELECT store, status FROM storage_deletion_queue WHERE storage_key=$1', [open.key]))[0]!;
    expect(queued).toEqual({ store: 'bank-imports', status: 'done' });
  });
  it('bank import file: a failed removal stays queued and is retried by the worker; unowned or re-referenced keys are skipped, never deleted', async () => {
    const account = (await q<{ id: string }>(`SELECT id FROM bank_accounts WHERE company_id=$1 LIMIT 1`, [A]))[0]!.id;
    let fail = true; const gone: string[] = [];
    const flaky: StorageAdapter = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: async (k: string) => { if (fail) throw new Error('storage down'); gone.push(k); } };
    const flakySvc = new RecordDeletionService(pool, flaky);
    const b = await batchRow(A, 'mapping_required', account);
    expect(await flakySvc.deleteBankImportBatch(A, user, b.id)).toEqual({ storage_cleanup: 'pending' });
    expect((await q<{ status: string; attempts: number }>('SELECT status, attempts FROM storage_deletion_queue WHERE storage_key=$1', [b.key]))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    fail = false;
    await q(`UPDATE storage_deletion_queue SET next_attempt_at = NOW() WHERE storage_key=$1`, [b.key]);
    expect(await new DocumentFileCleanup(pool, flaky, { 'bank-imports': flaky }).process()).toMatchObject({ done: 1 });
    expect(gone).toEqual([b.key]);
    // a key that belongs to another company prefix is never removed (the table CHECK forbids queuing it; simulate by a key re-referenced by a batch)
    const live = await batchRow(A, 'preview_ready', account);
    const qid = (await q<{ id: string }>(`INSERT INTO storage_deletion_queue (store, company_id, document_id, storage_key) VALUES ('bank-imports',$1,$2,$3) RETURNING id`, [A, randomUUID(), live.key]))[0]!.id;
    expect(await new DocumentFileCleanup(pool, flaky, { 'bank-imports': flaky }).process([qid])).toMatchObject({ skipped: 1, done: 0 });
    expect(gone).toEqual([b.key]);
    await q('DELETE FROM storage_deletion_queue WHERE company_id=ANY($1::uuid[])', [[A, B]]);
  });

  it('counterparty: deleted only when unreferenced, with version check and company isolation', async () => {
    const mk = async (co: string) => (await q<{ id: string }>(`INSERT INTO counterparties (company_id,name,type,created_by_user_id) VALUES ($1,'CP','customer',$2) RETURNING id`, [co, user]))[0]!.id;
    const free = await mk(A); const used = await mk(A);
    await q(`INSERT INTO obligations (company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES ($1,'receivable',$2,100,'2026-02-01','unconfirmed','manual',$3)`, [A, used, user]);
    await expect(svc.deleteCounterparty(A, user, used, 1)).rejects.toMatchObject({ reason: 'obligations' });
    await expect(svc.deleteCounterparty(A, user, free, 9)).rejects.toThrow();
    await expect(svc.deleteCounterparty(B, user, free, 1)).rejects.toThrow();
    await svc.deleteCounterparty(A, user, free, 1);
    expect(await count('SELECT count(*) n FROM counterparties WHERE id=ANY($1::uuid[])', [[free, used]])).toBe(1);
  });

  it('partner: deleted only when it has no ownership record', async () => {
    const mk = async () => (await q<{ id: string }>(`INSERT INTO partners (company_id,name,created_by_user_id) VALUES ($1,'P',$2) RETURNING id`, [A, user]))[0]!.id;
    const free = await mk(); const owner = await mk();
    await q(`INSERT INTO partner_ownership_periods (company_id,partner_id,ownership_percentage,effective_from,verification_status,created_by_user_id) VALUES ($1,$2,50,'2026-01-01','unconfirmed',$3)`, [A, owner, user]);
    await expect(svc.deletePartner(A, user, owner, 1)).rejects.toMatchObject({ reason: 'partner_ownership_periods' });
    await svc.deletePartner(A, user, free, 1);
    expect(await count('SELECT count(*) n FROM partners WHERE id=ANY($1::uuid[])', [[free, owner]])).toBe(1);
  });
});
