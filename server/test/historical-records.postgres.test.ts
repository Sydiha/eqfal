import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DocumentDeleteBlockedError, DocumentService } from '../src/modules/documents/document.service';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// C5-P2: historical records schema and database guards (migration 096). Static checks always run; database checks need DATABASE_URL.
const sql = readFileSync(new URL('../migrations/096_historical_records.sql', import.meta.url), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describe('Migration 096 historical records (static)', () => {
  it('is the next migration number and only one file uses it', () => {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
    expect(files.at(-1)).toBe('096_historical_records.sql');
    expect(files.filter((f) => f.startsWith('096_'))).toHaveLength(1);
  });

  it('never touches the ledger, fiscal years or opening balances', () => {
    expect(code).not.toMatch(/journal_entries|journal_lines|REFERENCES accounts|fiscal_years|opening_balance|ledger_source_authority/);
  });

  it('registers the three capabilities without granting them to any role', () => {
    for (const id of ['historical.view', 'historical.manage', 'historical.approve']) expect(code).toContain(`('${id}')`);
    expect(code).not.toMatch(/role_capabilities/);
  });
});

describeDatabase('historical records (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const companyA = randomUUID(); const companyB = randomUUID(); const user = randomUUID();
  const storage: StorageAdapter = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: async () => undefined };
  const documents = new DocumentService(pool, storage);
  let year = 2000;

  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-only')`, [user, `hist-${user}@example.test`]);
    for (const id of [companyA, companyB]) await pool.query(`INSERT INTO companies (id, slug, name) VALUES ($1, $2, 'Historical')`, [id, `hist-${id}`]);
  });
  afterAll(async () => {
    // Test-only cleanup: the guards forbid deletes, so they are disabled inside one transaction on this disposable database.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE historical_statement_lines DISABLE TRIGGER historical_statement_lines_guard');
      await client.query('ALTER TABLE historical_statement_versions DISABLE TRIGGER historical_statement_versions_guard');
      await client.query('ALTER TABLE historical_periods DISABLE TRIGGER historical_periods_guard');
      for (const t of ['historical_statement_lines', 'historical_statement_versions', 'historical_periods', 'fiscal_years', 'documents']) {
        await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[companyA, companyB]]);
      }
      await client.query('ALTER TABLE historical_statement_lines ENABLE TRIGGER historical_statement_lines_guard');
      await client.query('ALTER TABLE historical_statement_versions ENABLE TRIGGER historical_statement_versions_guard');
      await client.query('ALTER TABLE historical_periods ENABLE TRIGGER historical_periods_guard');
      await client.query('COMMIT');
    } finally { client.release(); }
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM storage_deletion_queue WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  async function period(company = companyA, start?: string, end?: string): Promise<string> {
    year += 1;
    return (await pool.query<{ id: string }>(
      `INSERT INTO historical_periods (company_id, label, period_start, period_end, completeness, status_reason, status_changed_by, created_by)
       VALUES ($1, $2, $3, $4, 'incomplete', 'Initial classification', $5, $5) RETURNING id`,
      [company, `FY ${year}`, start ?? `${year}-01-01`, end ?? `${year}-12-31`, user])).rows[0]!.id;
  }
  async function document(company = companyA): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO documents (id, company_id, uploaded_by_user_id, original_filename, mime_type, size_bytes, storage_key, sha256)
       VALUES ($1,$2,$3,'filing.pdf','application/pdf',1,$4,$5)`, [id, company, user, `${company}/${id}`, 'b'.repeat(64)]);
    return id;
  }
  async function official(periodId: string, opts: { versionNo?: number; proofDoc?: string | null; company?: string } = {}): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         submitted_to, submission_date, submission_reference, proof_level, proof_document_id, created_by)
       VALUES ($1,$2,'official','financial_position',$3,'SAR','Authority','2025-04-30','REF-1',$4,$5,$6) RETURNING id`,
      [opts.company ?? companyA, periodId, opts.versionNo ?? 1, opts.proofDoc ? 'proof_attached' : 'declared_unverified', opts.proofDoc ?? null, user])).rows[0]!.id;
  }
  async function internal(periodId: string, versionNo: number, purpose: 'reconstruction' | 'correction', basis: string | null): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         internal_purpose, basis_version_id, source_type, confidence, created_by)
       VALUES ($1,$2,'internal','financial_position',$3,'SAR',$4,$5,'bank_statement','medium',$6) RETURNING id`,
      [companyA, periodId, versionNo, purpose, basis, user])).rows[0]!.id;
  }
  const line = (versionId: string, lineNo: number, amount: string, doc: string | null = null, company = companyA) => pool.query(
    `INSERT INTO historical_statement_lines (company_id, version_id, line_no, line_code, label_en, amount, supporting_document_id)
     VALUES ($1,$2,$3,$4,'Line',$5,$6)`, [company, versionId, lineNo, `L${lineNo}`, amount, doc]);
  const seal = (id: string) => pool.query(`UPDATE historical_statement_versions SET state='sealed', sealed_by=$2, sealed_at=NOW(), fingerprint=repeat('0',64) WHERE id=$1 RETURNING fingerprint`, [id, user]);
  const sealedOfficial = async (periodId: string, proofDoc: string | null = null) => {
    const id = await official(periodId, { proofDoc }); await line(id, 1, '100.00'); await seal(id); return id;
  };

  it('accepts user-declared official data without proof and requires a document only for attached proof', async () => {
    const p = await period();
    await expect(official(p)).resolves.toBeTruthy();
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         submitted_to, submission_date, proof_level, created_by) VALUES ($1,$2,'official','profit_or_loss',1,'SAR','A','2025-01-01','proof_attached',$3)`,
      [companyA, p, user])).rejects.toMatchObject({ code: '23514' });
    const doc = await document();
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         submitted_to, submission_date, proof_level, proof_document_id, created_by) VALUES ($1,$2,'official','cash_flow',1,'SAR','A','2025-01-01','declared_unverified',$3,$4)`,
      [companyA, p, doc, user])).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps official and internal fields apart and requires a basis for a correction', async () => {
    const p = await period();
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         submitted_to, submission_date, proof_level, confidence, created_by) VALUES ($1,$2,'official','profit_or_loss',1,'SAR','A','2025-01-01','declared_unverified','high',$3)`,
      [companyA, p, user])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency, internal_purpose, created_by)
       VALUES ($1,$2,'internal','profit_or_loss',1,'SAR','reconstruction',$3)`, [companyA, p, user])).rejects.toMatchObject({ code: '23514' });
    await expect(internal(p, 1, 'correction', null)).rejects.toMatchObject({ code: '23514' });
    await expect(internal(p, 1, 'reconstruction', null)).resolves.toBeTruthy();
  });

  it('creates versions only as unreviewed drafts', async () => {
    const p = await period();
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         submitted_to, submission_date, proof_level, state, sealed_by, sealed_at, fingerprint, created_by)
       VALUES ($1,$2,'official','financial_position',1,'SAR','A','2025-01-01','declared_unverified','sealed',$3,NOW(),repeat('a',64),$3)`,
      [companyA, p, user])).rejects.toThrow(/HISTORICAL_VERSION_INVALID/);
  });

  it('seals only with lines, computes the fingerprint in the database and then freezes the version and its lines', async () => {
    const p = await period();
    const v = await official(p);
    await expect(seal(v)).rejects.toThrow(/HISTORICAL_VERSION_EMPTY/);
    await line(v, 1, '1500.25'); await line(v, 2, '-20.00');
    const fingerprint = (await seal(v)).rows[0]!.fingerprint as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toBe('0'.repeat(64));
    const recomputed = (await pool.query<{ f: string }>('SELECT historical_version_fingerprint($1) f', [v])).rows[0]!.f;
    expect(recomputed).toBe(fingerprint);
    await expect(line(v, 3, '1.00')).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`UPDATE historical_statement_lines SET amount = 1 WHERE version_id = $1`, [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`DELETE FROM historical_statement_lines WHERE version_id = $1`, [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`UPDATE historical_statement_versions SET submission_reference = 'X' WHERE id = $1`, [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`UPDATE historical_statement_versions SET state='voided', voided_by=$2, voided_at=NOW(), void_reason='x' WHERE id=$1`, [v, user])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`DELETE FROM historical_statement_versions WHERE id = $1`, [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
  });

  it('refuses content changes made together with sealing', async () => {
    const p = await period();
    const v = await official(p); await line(v, 1, '10.00');
    await expect(pool.query(`UPDATE historical_statement_versions SET state='sealed', sealed_by=$2, sealed_at=NOW(), fingerprint=repeat('0',64), submission_reference='NEW' WHERE id=$1`, [v, user]))
      .rejects.toThrow(/HISTORICAL_VERSION_INVALID/);
  });

  it('records internal review forward only and never as part of a draft', async () => {
    const p = await period();
    const draft = await official(p);
    await expect(pool.query(`UPDATE historical_statement_versions SET review_status='reviewed', reviewed_by=$2, reviewed_at=NOW() WHERE id=$1`, [draft, user])).rejects.toMatchObject({ code: '23514' });
    await line(draft, 1, '5.00'); await seal(draft);
    await pool.query(`UPDATE historical_statement_versions SET review_status='reviewed', reviewed_by=$2, reviewed_at=NOW() WHERE id=$1`, [draft, user]);
    await pool.query(`UPDATE historical_statement_versions SET review_status='approved', approved_by=$2, approved_at=NOW() WHERE id=$1`, [draft, user]);
    await expect(pool.query(`UPDATE historical_statement_versions SET review_status='reviewed', approved_by=NULL, approved_at=NULL WHERE id=$1`, [draft])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    const row = (await pool.query(`SELECT proof_level, state FROM historical_statement_versions WHERE id=$1`, [draft])).rows[0];
    expect(row).toEqual({ proof_level: 'declared_unverified', state: 'sealed' });
  });

  it('voids a draft permanently', async () => {
    const p = await period();
    const v = await official(p);
    await pool.query(`UPDATE historical_statement_versions SET state='voided', voided_by=$2, voided_at=NOW(), void_reason='Entered twice' WHERE id=$1`, [v, user]);
    await expect(pool.query(`UPDATE historical_statement_versions SET submitted_to='B' WHERE id=$1`, [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(line(v, 1, '1.00')).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
  });

  it('corrects a sealed official version through a new internal version and keeps the original; a later official filing is a new version', async () => {
    const p = await period();
    const original = await sealedOfficial(p);
    const before = (await pool.query(`SELECT fingerprint FROM historical_statement_versions WHERE id=$1`, [original])).rows[0]!.fingerprint;
    const unsealedBasis = await official(p, { versionNo: 9 });
    await expect(internal(p, 10, 'correction', unsealedBasis)).rejects.toThrow(/HISTORICAL_BASIS_INVALID/);
    const correction = await internal(p, 2, 'correction', original);
    await line(correction, 1, '120.00'); await seal(correction);
    const amended = await official(p, { versionNo: 3 });
    await line(amended, 1, '130.00'); await seal(amended);
    const rows = (await pool.query(`SELECT id, kind, state, fingerprint FROM historical_statement_versions WHERE period_id=$1 AND state='sealed' ORDER BY version_no`, [p])).rows;
    expect(rows.map((r) => [r.kind, r.state])).toEqual([['official', 'sealed'], ['internal', 'sealed'], ['official', 'sealed']]);
    expect(rows[0]!.fingerprint).toBe(before);
  });

  it('protects periods: no delete, a new reason for every status change, reopen allowed, dates fixed once a version exists', async () => {
    const p = await period();
    await expect(pool.query(`DELETE FROM historical_periods WHERE id=$1`, [p])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(pool.query(`UPDATE historical_periods SET reconstruction_status='in_progress' WHERE id=$1`, [p])).rejects.toThrow(/HISTORICAL_STATUS_REASON_REQUIRED/);
    const change = (status: string, reason: string) => pool.query(
      `UPDATE historical_periods SET reconstruction_status=$2, status_reason=$3, status_changed_by=$4, status_changed_at=clock_timestamp() WHERE id=$1`, [p, status, reason, user]);
    await change('in_progress', 'Started from bank statements');
    await change('completed', 'Reconstruction done');
    await change('in_progress', 'Reopened: missing supplier statement found');
    await official(p);
    await expect(pool.query(`UPDATE historical_periods SET period_end = period_end - 1 WHERE id=$1`, [p])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(period(companyA, `${year}-01-01`, `${year}-12-31`)).rejects.toMatchObject({ code: '23505' });
  });

  it('coexists with an operational fiscal year for the same dates and never creates journals', async () => {
    await pool.query(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1, 'FY 2026', '2026-01-01', '2026-12-31')`, [companyA]);
    const p = await period(companyA, '2026-01-01', '2026-06-30');
    const r = await internal(p, 1, 'reconstruction', null);
    await line(r, 1, '42.00');
    await seal(r);
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1`, [companyA])).rows[0]!.n)).toBe(0);
  });

  it('isolates companies: no cross-company period, basis, line or document', async () => {
    const pA = await period(companyA);
    await expect(official(pA, { company: companyB })).rejects.toMatchObject({ code: '23503' });
    const vA = await official(pA);
    await expect(line(vA, 1, '1.00', null, companyB)).rejects.toMatchObject({ code: '23503' });
    const docB = await document(companyB);
    await expect(line(vA, 1, '1.00', docB)).rejects.toMatchObject({ code: '23503' });
    const pB = await period(companyB);
    const sealedA = await sealedOfficial(await period(companyA));
    await expect(pool.query(
      `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency,
         internal_purpose, basis_version_id, source_type, confidence, created_by)
       VALUES ($1,$2,'internal','financial_position',2,'SAR','correction',$3,'bank_statement','low',$4)`, [companyB, pB, sealedA, user])).rejects.toThrow(/HISTORICAL_BASIS_INVALID|foreign key/);
  });

  it('protects referenced documents and keeps the existing review path working', async () => {
    const p = await period();
    const proof = await document(); const support = await document();
    const v = await official(p, { proofDoc: proof });
    await line(v, 1, '10.00', support);
    // Draft reference: the file may still be corrected, but the document cannot be deleted.
    await pool.query(`UPDATE documents SET sha256 = repeat('c',64) WHERE id = $1`, [proof]);
    await seal(v);
    for (const doc of [proof, support]) {
      await expect(pool.query(`UPDATE documents SET sha256 = repeat('d',64) WHERE id = $1`, [doc])).rejects.toThrow(/HISTORICAL_DOCUMENT_PROTECTED/);
      await expect(pool.query(`UPDATE documents SET storage_key = company_id::text || '/moved' WHERE id = $1`, [doc])).rejects.toThrow(/HISTORICAL_DOCUMENT_PROTECTED/);
      await expect(pool.query(`DELETE FROM documents WHERE id = $1`, [doc])).rejects.toMatchObject({ code: '23503' });
      const error = await documents.deleteDocument({ documentId: doc, companyId: companyA, actorUserId: user }).catch((e) => e);
      expect(error).toBeInstanceOf(DocumentDeleteBlockedError);
    }
    // Review and intake columns stay usable (existing document workflow).
    await pool.query(`UPDATE documents SET status = 'needs_review' WHERE id = $1`, [proof]);
    expect((await pool.query(`SELECT status FROM documents WHERE id = $1`, [proof])).rows[0]!.status).toBe('needs_review');
    // An unreferenced document is still deletable.
    const free = await document();
    await expect(documents.deleteDocument({ documentId: free, companyId: companyA, actorUserId: user })).resolves.toMatchObject({ deleted: true });
  });
});
