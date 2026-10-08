import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MembershipService } from '../src/modules/memberships/membership.service';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// Real PostgreSQL (migrations applied): H3 rules against real rows, including row locking.
describeDatabase('H3 owner-lockout and privilege rules with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const service = new MembershipService(pool);
  const companies: string[] = [];
  afterAll(async () => { await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]).catch(() => undefined); await pool.end(); });

  async function seed() {
    const company = randomUUID();
    companies.push(company);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'H3')", [company, `h3-${company}`]);
    const mkRole = async (name: string, full: boolean, caps: string[] = []) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name,is_full_access) VALUES($1,$2,$3) RETURNING id', [company, name, full])).rows[0]!.id;
      for (const cap of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, cap]);
      return id;
    };
    const mkMember = async (label: string, roleId: string) => {
      const user = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id", [`${label}-${company}@example.com`])).rows[0]!.id;
      const id = (await pool.query<{ id: string }>('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3) RETURNING id', [user, company, roleId])).rows[0]!.id;
      return { user, id };
    };
    const full = await mkRole('Full', true);
    const admin = await mkRole('Admin', false, ['access.membership.status.edit', 'access.membership.role.assign']);
    return { company, full, admin, owner: await mkMember('owner', full), admin1: await mkMember('admin', admin) };
  }

  it('limited admin cannot disable or demote the Full Access owner; owner row stays active with its role', async () => {
    const s = await seed();
    await expect(service.setMembershipActive(s.owner.id, s.company, false, s.admin1.user)).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(service.assignRoleForCompany(s.owner.id, s.admin, s.company, s.admin1.user)).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    const row = (await pool.query('SELECT is_active, role_id FROM memberships WHERE id=$1', [s.owner.id])).rows[0];
    expect(row).toEqual({ is_active: true, role_id: s.full });
  });

  it('the last active Full Access member cannot be disabled or demoted, but can once a second exists', async () => {
    const s = await seed();
    await expect(service.setMembershipActive(s.owner.id, s.company, false, s.owner.user)).rejects.toMatchObject({ code: 'ACCESS_LAST_FULL_ACCESS' });
    await expect(service.assignRoleForCompany(s.owner.id, s.admin, s.company, s.owner.user)).rejects.toMatchObject({ code: 'ACCESS_LAST_FULL_ACCESS' });
    const second = await (async () => {
      const user = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id", [`o2-${s.company}@example.com`])).rows[0]!.id;
      return (await pool.query<{ id: string }>('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3) RETURNING id', [user, s.company, s.full])).rows[0]!.id;
    })();
    await expect(service.setMembershipActive(second, s.company, false, s.owner.user)).resolves.toMatchObject({ is_active: false });
    await expect(service.setMembershipActive(s.owner.id, s.company, false, s.owner.user)).rejects.toMatchObject({ code: 'ACCESS_LAST_FULL_ACCESS' });
  });

  it('two concurrent disables of the only two Full Access members cannot both succeed', async () => {
    const s = await seed();
    const user = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id", [`o2-${s.company}@example.com`])).rows[0]!.id;
    const second = (await pool.query<{ id: string }>('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3) RETURNING id', [user, s.company, s.full])).rows[0]!.id;
    const results = await Promise.allSettled([
      service.setMembershipActive(s.owner.id, s.company, false, s.owner.user),
      service.setMembershipActive(second, s.company, false, user),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await pool.query("SELECT 1 FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.company_id=$1 AND m.is_active AND r.is_full_access", [s.company]);
    expect(active.rowCount).toBe(1);
  });
});
