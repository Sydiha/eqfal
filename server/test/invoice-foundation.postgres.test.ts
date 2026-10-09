import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PR-1 invoicing database foundation (migration 062). Requires an isolated, disposable PostgreSQL database.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const migrationsDir = path.resolve(__dirname, '../migrations');

describeDatabase('invoice foundation (migration 062) with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const user = randomUUID();
  const coA = randomUUID(), coB = randomUUID();
  const cpA = randomUUID(), cpA2 = randomUUID(), cpB = randomUUID();
  const docA = randomUUID(), docA2 = randomUUID(), docB = randomUUID();

  async function company(id: string, cp: string, doc: string) {
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'C')", [id, `inv-${id}`]);
    await pool.query("INSERT INTO counterparties(id,company_id,name,type,created_by_user_id) VALUES($1,$2,'P','customer',$3)", [cp, id, user]);
    await pool.query(
      "INSERT INTO documents(id,company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,$3,'a.pdf','application/pdf',1,$4,$5)",
      [doc, id, user, `k-${doc}`, 'a'.repeat(64)],
    );
  }
  async function invoice(o: Partial<{ id: string; company: string; cp: string; direction: string; status: string; ext: string | null; number: number | null; total: string }> = {}) {
    const id = o.id ?? randomUUID();
    const status = o.status ?? 'draft';
    const approved = status === 'approved';
    await pool.query(
      `INSERT INTO invoices(id,company_id,direction,status,counterparty_id,internal_number,external_reference,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'2026-10-01',1000,150,$8,$9,$10,$11)`,
      [id, o.company ?? coA, o.direction ?? 'sales', status, o.cp ?? cpA, approved ? (o.number ?? 1) : null, o.ext ?? null, o.total ?? '1150', user, approved ? user : null, approved ? new Date() : null],
    );
    return id;
  }
  const line = (invoiceId: string, n = 1, company = coA) =>
    pool.query(
      "INSERT INTO invoice_lines(company_id,invoice_id,line_number,description,quantity,unit_price,vat_rate,net_amount,vat_amount,total_amount) VALUES($1,$2,$3,'x',1,1000,15,1000,150,1150)",
      [company, invoiceId, n],
    );
  const rejects = (p: Promise<unknown>) => expect(p).rejects.toThrow();

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [user, `${user}@example.test`]);
    await company(coA, cpA, docA);
    await company(coB, cpB, docB);
    await pool.query("INSERT INTO counterparties(id,company_id,name,type,created_by_user_id) VALUES($1,$2,'P2','supplier',$3)", [cpA2, coA, user]);
    await pool.query(
      "INSERT INTO documents(id,company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,$3,'b.pdf','application/pdf',1,$4,$5)",
      [docA2, coA, user, `k-${docA2}`, 'b'.repeat(64)],
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[coA, coB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  it('tenant isolation: cross-company counterparty, original invoice and document are rejected', async () => {
    await rejects(invoice({ company: coA, cp: cpB }));
    const a = await invoice();
    const b = await invoice({ company: coB, cp: cpB });
    await rejects(pool.query(
      "INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,adjustment_date,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id) VALUES($1,$2,'sales','credit','2026-10-02',10,0,10,'r',$3)",
      [coA, b, user],
    ));
    await rejects(pool.query('INSERT INTO invoice_source_links(company_id,invoice_id,document_id,created_by_user_id) VALUES($1,$2,$3,$4)', [coA, a, docB, user]));
    await rejects(line(a, 1, coB));
  });

  it('constraints: currency, negatives, totals, dates, number/status coupling', async () => {
    const base = (extra: string, vals: unknown[]) =>
      pool.query(
        `INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id${extra.split('|')[0]}) VALUES($1,'sales',$2,'2026-10-01',100,15,115,$3${extra.split('|')[1]})`,
        [coA, cpA, user, ...vals],
      );
    await base('|', []); // sanity: valid draft
    await rejects(base(',currency|,$4', ['USD']));
    await rejects(pool.query("INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id) VALUES($1,'sales',$2,'2026-10-01',-1,0,-1,$3)", [coA, cpA, user]));
    await rejects(pool.query("INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id) VALUES($1,'sales',$2,'2026-10-01',100,15,999,$3)", [coA, cpA, user]));
    await rejects(base(',due_date|,$4', ['2026-09-01']));
    await rejects(base(',internal_number|,$4', [5])); // number on a non-approved invoice
    await rejects(pool.query("INSERT INTO invoices(company_id,direction,status,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id) VALUES($1,'sales','approved',$2,'2026-10-01',100,15,115,$3)", [coA, cpA, user]));
    await rejects(pool.query("INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id) VALUES($1,'other',$2,'2026-10-01',100,15,115,$3)", [coA, cpA, user]));
  });

  it('line constraints and adjustment constraints', async () => {
    const inv = await invoice();
    await line(inv, 1);
    await rejects(line(inv, 1)); // duplicate line number
    await rejects(pool.query("INSERT INTO invoice_lines(company_id,invoice_id,line_number,description,quantity,unit_price,vat_rate,net_amount,vat_amount,total_amount) VALUES($1,$2,2,'x',0,1,15,1,0,1)", [coA, inv]));
    await rejects(pool.query("INSERT INTO invoice_lines(company_id,invoice_id,line_number,description,quantity,unit_price,vat_rate,net_amount,vat_amount,total_amount) VALUES($1,$2,3,'x',1,-1,15,1,0,1)", [coA, inv]));
    const sales = await invoice({ status: 'approved', number: 900 });
    const adj = (orig: string, dir: string, total = 10) =>
      pool.query(
        "INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,adjustment_date,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id) VALUES($1,$2,$3,'credit','2026-10-02',$4,0,$4,'r',$5)",
        [coA, orig, dir, total, user],
      );
    await adj(sales, 'sales');
    await rejects(adj(sales, 'purchase')); // direction differs from original
    await rejects(adj(randomUUID(), 'sales')); // no original
    await rejects(adj(sales, 'sales', -5));
  });

  it('uniqueness: internal number, supplier reference, document link', async () => {
    const dupNo = await invoice({ status: 'approved', number: 500 });
    expect(dupNo).toBeTruthy();
    await rejects(invoice({ status: 'approved', number: 500 }));
    await invoice({ status: 'approved', number: 500, direction: 'purchase' }); // same number, other direction: fine
    await invoice({ direction: 'purchase', ext: 'SUP-1', cp: cpA });
    await rejects(invoice({ direction: 'purchase', ext: 'SUP-1', cp: cpA }));
    await invoice({ direction: 'purchase', ext: 'SUP-1', cp: cpA2 }); // different supplier: fine
    const i1 = await invoice(), i2 = await invoice();
    await pool.query('INSERT INTO invoice_source_links(company_id,invoice_id,document_id,created_by_user_id) VALUES($1,$2,$3,$4)', [coA, i1, docA, user]);
    await rejects(pool.query('INSERT INTO invoice_source_links(company_id,invoice_id,document_id,created_by_user_id) VALUES($1,$2,$3,$4)', [coA, i2, docA, user]));
  });

  it('recurring-ready columns: coupling and duplicate-generation prevention', async () => {
    const tpl = randomUUID();
    const rec = (date: string | null, origin = 'recurring', template: string | null = tpl) =>
      pool.query(
        "INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id,origin,recurring_template_id,recurrence_occurrence_date) VALUES($1,'sales',$2,'2026-10-01',1,0,1,$3,$4,$5,$6)",
        [coA, cpA, user, origin, template, date],
      );
    await rec('2026-10-01');
    await rejects(rec('2026-10-01')); // same occurrence generated twice
    await rec('2026-11-01'); // next occurrence is fine
    await rejects(rec(null)); // recurring needs an occurrence date
    await rejects(rec('2026-12-01', 'manual')); // manual cannot carry template fields
  });

  it('immutability: approved invoices, lines, links and adjustments cannot be changed or deleted', async () => {
    const draft = await invoice();
    await line(draft, 1);
    await pool.query('INSERT INTO invoice_source_links(company_id,invoice_id,document_id,created_by_user_id) VALUES($1,$2,$3,$4)', [coA, draft, docA2, user]);
    await pool.query("UPDATE invoices SET status='submitted' WHERE id=$1", [draft]);
    await rejects(line(draft, 2)); // lines frozen after submission
    await rejects(pool.query('DELETE FROM invoice_lines WHERE invoice_id=$1', [draft]));
    await rejects(pool.query('DELETE FROM invoice_source_links WHERE invoice_id=$1', [draft]));
    await pool.query("UPDATE invoices SET status='approved', internal_number=700, approved_at=NOW(), approved_by_user_id=$2 WHERE id=$1", [draft, user]);
    await rejects(pool.query("UPDATE invoices SET notes='tamper' WHERE id=$1", [draft]));
    await rejects(pool.query("UPDATE invoices SET total_amount=1, subtotal_amount=1, vat_amount=0 WHERE id=$1", [draft]));
    await rejects(pool.query("UPDATE invoices SET status='cancelled' WHERE id=$1", [draft]));
    await rejects(pool.query('DELETE FROM invoices WHERE id=$1', [draft]));
    await rejects(pool.query("UPDATE invoice_lines SET description='tamper' WHERE invoice_id=$1", [draft]));
    await rejects(pool.query('DELETE FROM invoice_lines WHERE invoice_id=$1', [draft]));
    // invalid transitions on non-frozen rows
    const d2 = await invoice();
    await rejects(pool.query("UPDATE invoices SET status='approved', internal_number=701, approved_at=NOW(), approved_by_user_id=$2 WHERE id=$1", [d2, user])); // draft -> approved skips submit
    await pool.query('DELETE FROM invoices WHERE id=$1', [d2]); // drafts are deletable
    // adjustments
    const orig = await invoice({ status: 'approved', number: 800 });
    const adjId = (await pool.query<{ id: string }>(
      "INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,status,adjustment_date,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id,approved_by_user_id,approved_at) VALUES($1,$2,'sales','credit','approved','2026-10-02',10,0,10,'r',$3,$3,NOW()) RETURNING id",
      [coA, orig, user],
    )).rows[0]!.id;
    await rejects(pool.query("UPDATE invoice_adjustments SET reason='tamper' WHERE id=$1", [adjId]));
    await rejects(pool.query('DELETE FROM invoice_adjustments WHERE id=$1', [adjId]));
    await rejects(pool.query('DELETE FROM invoices WHERE id=$1', [orig]));
  });

  it('numbering: parallel transactions get distinct consecutive numbers; rollback consumes nothing', async () => {
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      const n1 = await c1.query<{ n: string }>("SELECT allocate_invoice_number($1,'sales') AS n", [coA]);
      const second = c2.query<{ n: string }>("SELECT allocate_invoice_number($1,'sales') AS n", [coA]); // blocks on c1's row lock
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const n2 = await second;
      await c2.query('COMMIT');
      expect(Number(n1.rows[0]!.n)).toBe(1);
      expect(Number(n2.rows[0]!.n)).toBe(2);
      await c1.query('BEGIN');
      const n3 = await c1.query<{ n: string }>("SELECT allocate_invoice_number($1,'sales') AS n", [coA]);
      expect(Number(n3.rows[0]!.n)).toBe(3);
      await c1.query('ROLLBACK');
      const n4 = await pool.query<{ n: string }>("SELECT allocate_invoice_number($1,'sales') AS n", [coA]);
      expect(Number(n4.rows[0]!.n)).toBe(3); // rolled-back number reused
      const other = await pool.query<{ n: string }>("SELECT allocate_invoice_number($1,'purchase') AS n", [coA]);
      expect(Number(other.rows[0]!.n)).toBe(1); // independent per direction
      const otherCo = await pool.query<{ n: string }>("SELECT allocate_invoice_number($1,'sales') AS n", [coB]);
      expect(Number(otherCo.rows[0]!.n)).toBe(1); // independent per company
    } finally { c1.release(); c2.release(); }
    await rejects(pool.query("UPDATE invoice_number_counters SET last_number=1 WHERE company_id=$1 AND direction='sales'", [coA]));
    await rejects(pool.query('DELETE FROM invoice_number_counters WHERE company_id=$1', [coA]));
  });

  it('permissions: no invoice.* capability is registered, so no role (including Full Access) gains one', async () => {
    expect((await pool.query("SELECT 1 FROM capabilities WHERE id LIKE 'invoice.%'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM role_capabilities WHERE capability_id LIKE 'invoice.%'")).rowCount).toBe(0);
    const role = (await pool.query<{ id: string }>("INSERT INTO roles(company_id,name,is_full_access) VALUES($1,'FullInv',TRUE) RETURNING id", [coA])).rows[0]!.id;
    const resolved = await pool.query("SELECT cap.id FROM roles r JOIN capabilities cap ON r.is_full_access = TRUE WHERE r.id=$1 AND cap.id LIKE 'invoice.%'", [role]);
    expect(resolved.rowCount).toBe(0);
  });

  it('migration 062 leaves existing accounting data byte-identical', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const dbName = `eqfal_mig062_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } catch {
      await admin.end();
      return; // cannot create a scratch database in this environment
    }
    const u = new URL(databaseUrl!); u.pathname = `/${dbName}`;
    const scratch = new Pool({ connectionString: u.toString() });
    try {
      const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((x) => x < '062')) await scratch.query(readFileSync(path.join(migrationsDir, f), 'utf8'));
      const uid = randomUUID(), cid = randomUUID(), cpid = randomUUID();
      await scratch.query("INSERT INTO users(id,email,password_hash) VALUES($1,'m@example.test','x')", [uid]);
      await scratch.query("INSERT INTO companies(id,slug,name) VALUES($1,'m','M')", [cid]);
      await scratch.query("INSERT INTO counterparties(id,company_id,name,type,created_by_user_id) VALUES($1,$2,'P','customer',$3)", [cpid, cid, uid]);
      await scratch.query("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,'a.pdf','application/pdf',1,'mk',$3)", [cid, uid, 'c'.repeat(64)]);
      const tables = (await scratch.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> '_schema_migrations' ORDER BY 1")).rows.map((r) => r.t);
      const fingerprint = async () => {
        const out: Record<string, string> = {};
        for (const t of tables) out[t] = (await scratch.query<{ h: string }>(`SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
        return out;
      };
      const before = await fingerprint();
      await scratch.query(readFileSync(path.join(migrationsDir, '062_invoice_foundation.sql'), 'utf8'));
      const after = await fingerprint();
      expect(after).toEqual(before);
      expect(tables.length).toBeGreaterThan(30);
      const added = (await scratch.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'invoice%' ORDER BY 1")).rows.map((r) => r.table_name);
      expect(added).toEqual(['invoice_adjustments', 'invoice_lines', 'invoice_number_counters', 'invoice_source_links', 'invoices']);
    } finally {
      await scratch.end();
      await admin.query(`DROP DATABASE ${dbName}`);
      await admin.end();
    }
  });
});
