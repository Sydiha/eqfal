import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyAccessError, CompanyManagementService } from '../src/modules/companies/company.service';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

describeDatabase('company logo storage with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const service = new CompanyManagementService(pool);
  const admin = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
  const coA = randomUUID(), coB = randomUUID();

  async function company(id: string) {
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'C')", [id, `logo-${id}`]);
    const full = (await pool.query<{ id: string }>("INSERT INTO roles(company_id,name,is_full_access) VALUES($1,'Full',TRUE) RETURNING id", [id])).rows[0]!.id;
    const view = (await pool.query<{ id: string }>("INSERT INTO roles(company_id,name,is_full_access) VALUES($1,'View',FALSE) RETURNING id", [id])).rows[0]!.id;
    await pool.query("INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,'company.view')", [view]);
    return { full, view };
  }
  beforeAll(async () => {
    for (const u of [admin, viewer, outsider]) await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [u, `${u}@example.test`]);
    const a = await company(coA); await company(coB);
    await pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [admin, coA, a.full]);
    await pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [viewer, coA, a.view]);
    const b = (await pool.query<{ id: string }>("SELECT id FROM roles WHERE company_id=$1 AND is_full_access", [coB])).rows[0]!.id;
    await pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [outsider, coB, b]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [[coA, coB]]).catch(() => undefined);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[coA, coB]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, viewer, outsider]]);
    await pool.end();
  });

  it('company without logo returns null', async () => { expect(await service.getLogo(coA, admin)).toBeNull(); });
  it('upload, persist, replace, remove', async () => {
    const up = await service.setLogo(coA, 'image/png', PNG, admin);
    expect(up.size_bytes).toBe(PNG.length);
    const got = await service.getLogo(coA, viewer);
    expect(got?.mime_type).toBe('image/png'); expect(Buffer.compare(got!.data, PNG)).toBe(0); expect(got!.sha256).toBe(up.sha256);
    const re = await service.setLogo(coA, 'image/png', PNG2, admin);
    expect(re.sha256).not.toBe(up.sha256);
    expect((await pool.query('SELECT 1 FROM company_logos WHERE company_id=$1', [coA])).rowCount).toBe(1);
    await service.removeLogo(coA, admin);
    expect(await service.getLogo(coA, admin)).toBeNull();
  });
  it('write needs company.edit; viewer is forbidden, outsider sees not_found', async () => {
    await expect(service.setLogo(coA, 'image/png', PNG, viewer)).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(service.removeLogo(coA, viewer)).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(service.setLogo(coA, 'image/png', PNG, outsider)).rejects.toBeInstanceOf(CompanyAccessError);
    await expect(service.setLogo(coA, 'image/png', PNG, outsider)).rejects.toMatchObject({ kind: 'not_found' });
  });
  it('isolates companies: other company cannot read or remove a logo', async () => {
    await service.setLogo(coA, 'image/png', PNG, admin);
    await expect(service.getLogo(coA, outsider)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(service.removeLogo(coA, outsider)).rejects.toMatchObject({ kind: 'not_found' });
    expect(await service.getLogo(coB, outsider)).toBeNull();
    expect((await service.getLogo(coA, admin))?.size_bytes).toBe(PNG.length);
  });
  it('database rejects bad mime or oversize rows', async () => {
    await expect(pool.query("UPDATE company_logos SET mime_type='image/svg+xml' WHERE company_id=$1", [coA])).rejects.toThrow();
    await expect(pool.query('UPDATE company_logos SET size_bytes=524289 WHERE company_id=$1', [coA])).rejects.toThrow();
  });
  it('deleting a company cascades its logo', async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'T')", [id, `logo-${id}`]);
    await pool.query("INSERT INTO company_logos(company_id,mime_type,size_bytes,sha256,data) VALUES($1,'image/png',1,$2,'\\x00')", [id, 'a'.repeat(64)]);
    await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    expect((await pool.query('SELECT 1 FROM company_logos WHERE company_id=$1', [id])).rowCount).toBe(0);
  });
});
