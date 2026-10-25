import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../migrations/095_user_display_name.sql', import.meta.url), 'utf8');
const databaseUrl = process.env['DATABASE_URL'];

describe('Migration 095 user display name', () => {
  it('follows 094 and only one file uses its number', () => {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
    expect(files[files.indexOf('095_user_display_name.sql') - 1]).toMatch(/^094_/);
    expect(files.filter((f) => f.startsWith('095_'))).toHaveLength(1);
  });

  it('is additive and nullable: existing accounts keep no name, nothing is derived from the email', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS display_name TEXT;/);
    expect(sql).not.toMatch(/NOT NULL DEFAULT|UPDATE users|split_part/i);
    expect(sql).toMatch(/users_display_name_check/);
  });

  (databaseUrl ? it : it.skip)('the applied column is nullable and the CHECK rejects blank or untrimmed names', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const column = (await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name='display_name'")).rows[0];
      expect(column?.is_nullable).toBe('YES');
      const check = (await pool.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='users_display_name_check'")).rows[0];
      expect(check?.def).toMatch(/btrim/);
      // Enforced by the database itself (inside a rolled-back transaction: nothing persists).
      const client = await pool.connect();
      try {
        for (const bad of ['', ' a', 'x'.repeat(101)]) {
          await client.query('BEGIN');
          await expect(client.query("INSERT INTO users(email,password_hash,display_name) VALUES('dn-check@example.test','x',$1)", [bad])).rejects.toThrow(/users_display_name_check/);
          await client.query('ROLLBACK');
        }
        await client.query('BEGIN');
        await client.query("INSERT INTO users(email,password_hash) VALUES('dn-check@example.test','x')");
        await client.query('ROLLBACK');
      } finally { client.release(); }
    } finally { await pool.end(); }
  });
});
