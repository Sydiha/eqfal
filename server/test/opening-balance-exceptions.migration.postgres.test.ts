import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

// This suite creates and drops temporary databases. It runs only when pointed at
// an explicitly approved disposable PostgreSQL instance.
const testDatabaseUrl = process.env['EQFAL_MIGRATION_TEST_DATABASE_URL'];
const allowDatabaseCreate = process.env['EQFAL_ALLOW_TEST_DATABASE_CREATE'] === '1';
const describeDatabase = testDatabaseUrl && allowDatabaseCreate ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration108 = readFileSync(new URL('../migrations/108_opening_balance_cash_evidence_exceptions.sql', import.meta.url), 'utf8');

describeDatabase('opening balance evidence exception migration 108 (PostgreSQL)', () => {
  let admin: Pool;
  let freshPool: Pool;
  let upgradePool: Pool;
  let freshDatabase: string;
  let upgradeDatabase: string;

  function connectionFor(database: string) {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async function createDatabase(database: string) {
    await admin.query(`CREATE DATABASE ${database}`);
  }

  async function applyMigrationsThrough107(pool: Pool) {
    await pool.query(`CREATE TABLE _schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) < 108)
      .sort();
    for (const file of files) {
      await pool.query(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
      await pool.query('INSERT INTO _schema_migrations(filename) VALUES($1)', [file]);
    }
  }

  async function fixture(pool: Pool) {
    const suffix = randomUUID().replace(/-/g, '');
    const companyId = (await pool.query<{ id: string }>(
      'INSERT INTO companies(slug,name) VALUES($1,$1) RETURNING id', [`mig108-${suffix}`],
    )).rows[0]!.id;
    const userId = (await pool.query<{ id: string }>(
      'INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [`mig108-${suffix}@example.test`, 'test-hash'],
    )).rows[0]!.id;
    const fiscalYearId = (await pool.query<{ id: string }>(
      `INSERT INTO fiscal_years(company_id,name,start_date,end_date)
       VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id`, [companyId],
    )).rows[0]!.id;
    const accountId = (await pool.query<{ id: string }>(
      `INSERT INTO accounts(company_id,code,name,account_type,statement_category)
       VALUES($1,$2,'Migration fixture','asset','current_asset') RETURNING id`, [companyId, `MIG108-${suffix}`],
    )).rows[0]!.id;
    const reviewId = (await pool.query<{ id: string }>(
      `INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,status,prepared_by)
       VALUES($1,$2,'draft',$3) RETURNING id`, [companyId, fiscalYearId, userId],
    )).rows[0]!.id;
    const bankItemId = (await pool.query<{ id: string }>(
      `INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by)
       VALUES($1,$2,'bank',$3,1,'debit','original_document','high',$4) RETURNING id`, [companyId, reviewId, accountId, userId],
    )).rows[0]!.id;
    const cashItemId = (await pool.query<{ id: string }>(
      `INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by)
       VALUES($1,$2,'cash_on_hand',$3,1,'debit','original_document','high',$4) RETURNING id`, [companyId, reviewId, accountId, userId],
    )).rows[0]!.id;
    await pool.query(
      "UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE id=$1",
      [reviewId, userId],
    );
    return { companyId, reviewId, userId, bankItemId, cashItemId };
  }

  async function insertException(
    pool: Pool,
    row: { companyId: string; reviewId: string; userId: string; itemId: string; section: string; issueCode: string },
  ) {
    const id = randomUUID();
    const digest = randomUUID().replace(/-/g, '').repeat(2);
    await pool.query(
      `INSERT INTO opening_balance_evidence_exceptions
        (id,company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,reason,accepted_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,'Migration compatibility test',$9)`,
      [id, row.companyId, row.reviewId, row.itemId, row.section, row.issueCode, digest, digest, row.userId],
    );
    return id;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
    freshDatabase = `eqfal_108_fresh_${nonce}`;
    upgradeDatabase = `eqfal_108_upgrade_${nonce}`;
    await createDatabase(freshDatabase);
    await createDatabase(upgradeDatabase);
    freshPool = new Pool({ connectionString: connectionFor(freshDatabase) });
    upgradePool = new Pool({ connectionString: connectionFor(upgradeDatabase) });
  }, 120_000);

  afterAll(async () => {
    await freshPool?.end();
    await upgradePool?.end();
    if (admin) {
      for (const database of [freshDatabase, upgradeDatabase]) {
        if (database) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
      await admin.end();
    }
  }, 120_000);

  it('applies 097 and 108 on a fresh installation and accepts physical cash evidence', async () => {
    await runMigrations(freshPool);
    const applied = await freshPool.query<{ filename: string }>(
      "SELECT filename FROM _schema_migrations WHERE filename = '108_opening_balance_cash_evidence_exceptions.sql'",
    );
    expect(applied.rows).toHaveLength(1);
    const fixtureRows = await fixture(freshPool);
    await insertException(freshPool, {
      companyId: fixtureRows.companyId,
      reviewId: fixtureRows.reviewId,
      userId: fixtureRows.userId,
      itemId: fixtureRows.cashItemId,
      section: 'cash_on_hand',
      issueCode: 'OB_PHYSICAL_CASH_EVIDENCE_MISSING',
    });
    const row = await freshPool.query<{ section: string; issue_code: string }>(
      "SELECT section, issue_code FROM opening_balance_evidence_exceptions WHERE section = 'cash_on_hand'",
    );
    expect(row.rows).toEqual([{ section: 'cash_on_hand', issue_code: 'OB_PHYSICAL_CASH_EVIDENCE_MISSING' }]);
  }, 120_000);

  it('upgrades an already-applied 097 schema, keeps its row, and accepts physical cash evidence', async () => {
    await applyMigrationsThrough107(upgradePool);
    const oldApplied = await upgradePool.query<{ filename: string }>(
      "SELECT filename FROM _schema_migrations WHERE filename = '097_opening_balance_evidence_exceptions.sql'",
    );
    expect(oldApplied.rows).toHaveLength(1);
    const fixtureRows = await fixture(upgradePool);
    const previousId = await insertException(upgradePool, {
      companyId: fixtureRows.companyId,
      reviewId: fixtureRows.reviewId,
      userId: fixtureRows.userId,
      itemId: fixtureRows.bankItemId,
      section: 'bank',
      issueCode: 'OB_BANK_AGGREGATE_ONLY',
    });

    await upgradePool.query('BEGIN');
    try {
      await upgradePool.query(migration108);
      await upgradePool.query('INSERT INTO _schema_migrations(filename) VALUES($1)', ['108_opening_balance_cash_evidence_exceptions.sql']);
      await upgradePool.query('COMMIT');
    } catch (error) {
      await upgradePool.query('ROLLBACK');
      throw error;
    }

    await insertException(upgradePool, {
      companyId: fixtureRows.companyId,
      reviewId: fixtureRows.reviewId,
      userId: fixtureRows.userId,
      itemId: fixtureRows.cashItemId,
      section: 'cash_on_hand',
      issueCode: 'OB_PHYSICAL_CASH_EVIDENCE_USER_DECLARED',
    });
    const rows = await upgradePool.query<{ id: string; section: string; issue_code: string }>(
      'SELECT id, section, issue_code FROM opening_balance_evidence_exceptions ORDER BY id',
    );
    expect(rows.rows).toContainEqual({ id: previousId, section: 'bank', issue_code: 'OB_BANK_AGGREGATE_ONLY' });
    expect(rows.rows).toHaveLength(2);
  }, 120_000);
});
