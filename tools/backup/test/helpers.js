'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mkTmp = (p = 'eqfal-bk-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PASS = 'synthetic-test-passphrase-0001';

function hasPgTools() {
  return ['pg_dump', 'pg_restore'].every((c) => spawnSync(c, ['--version']).status === 0);
}

function withDb(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function adminExec(adminUrl, sql) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

// Synthetic data only: fake company, fake user, balanced journal entries, fake files.
async function seedSynthetic(dbUrl, docsDir, bankDir) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const co = (await c.query(`INSERT INTO companies(slug,name) VALUES('synthetic-co','Synthetic Co') RETURNING id`)).rows[0].id;
    const us = (await c.query(`INSERT INTO users(email,password_hash) VALUES('synthetic@example.invalid','x') RETURNING id`)).rows[0].id;
    const fy = (await c.query(`INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY2026','2026-01-01','2026-12-31') RETURNING id`, [co])).rows[0].id;
    const acc = {};
    for (const [code, type] of [['1000', 'asset'], ['3000', 'equity'], ['4000', 'revenue']]) {
      acc[code] = (await c.query(`INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$3,$4) RETURNING id`, [co, code, `Acct ${code}`, type])).rows[0].id;
    }
    for (const [i, amount] of [['1', '1500.50'], ['2', '320.00']]) {
      const je = (await c.query(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,('2026-03-0'||$3::text)::date,'Synthetic entry',$4) RETURNING id`, [co, fy, i, us])).rows[0].id;
      await c.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$4,0,1),($1,$2,$5,0,$4,2)`, [co, je, acc['1000'], amount, acc['4000']]);
      await c.query(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [je, us]);
    }
    const files = [];
    for (let i = 0; i < 3; i++) {
      const data = Buffer.from(`synthetic document ${i} ${crypto.randomUUID()}`);
      const key = `${co}/${crypto.randomUUID()}`;
      fs.mkdirSync(path.dirname(path.join(docsDir, key)), { recursive: true });
      fs.writeFileSync(path.join(docsDir, key), data);
      await c.query(`INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,$3,'text/plain',$4,$5,$6)`, [co, us, `doc${i}.txt`, data.length, key, sha(data)]);
      files.push({ key, data });
    }
    const ba = (await c.query(`INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Synthetic Bank','SAR',$2) RETURNING id`, [co, us])).rows[0].id;
    const csv = Buffer.from('date,amount\n2026-03-01,100.00\n');
    const bkey = `${co}/${crypto.randomUUID()}`;
    fs.mkdirSync(path.dirname(path.join(bankDir, bkey)), { recursive: true });
    fs.writeFileSync(path.join(bankDir, bkey), csv);
    await c.query(`INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$4,'mapping_required',$5)`, [co, ba, bkey, sha(csv), us]);
    return { company: co, files, bankKey: bkey };
  } finally { await c.end(); }
}

module.exports = { sha, mkTmp, PASS, hasPgTools, withDb, adminExec, seedSynthetic };
