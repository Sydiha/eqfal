import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { hasPrivilegedFinancialAuthority } from '../src/modules/memberships/privileged-financial-authority';

const database = process.env.DATABASE_URL ? describe : describe.skip;
database('privileged financial authority (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it.each(['system_admin', 'company_manager', 'finance_manager'] as const)(
    '%s may approve its own advance only in authorized company scope', async (role) => {
      const owner = await h.user(`${role}-owner`);
      const actor = await h.user(`${role}-actor`);
      const other = await h.user(`${role}-other`);
      const company = await h.company(`${role}-home`, owner.id);
      const foreign = await h.company(`${role}-foreign`, other.id);
      if (role === 'system_admin') {
        await h.q('UPDATE users SET is_system_admin=TRUE WHERE id=$1', [actor.id]);
      } else {
        const policyRole = (await h.q<{id:string}>(
          'SELECT id FROM roles WHERE company_id=$1 AND authorization_policy_key=$2', [company, role]))[0]!;
        await h.q('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [actor.id, company, policyRole.id]);
        for (const cap of ['employee.view', 'employee_salary_advance.view', 'employee_salary_advance.create', 'employee_salary_advance.approve']) {
          await h.q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [policyRole.id, cap]);
        }
      }
      expect(await hasPrivilegedFinancialAuthority(h.db, company, actor.id)).toBe(true);
      expect(await hasPrivilegedFinancialAuthority(h.db, foreign, actor.id)).toBe(role === 'system_admin');
      await owner.client.login();
      await actor.client.login();
      if (role === 'system_admin') expect((await actor.client.req('POST', '/auth/switch-company', { companyId: company })).status).toBe(200);
      const employee = await owner.client.req('POST', '/employees', { employee_number: `PF${role}`, display_name: 'Privilege Test', employment_start: '2026-01-01', employment_end: null });
      expect(employee.status).toBe(201);
      const created = await actor.client.req('POST', '/employee-salary-advances', { employee_id: employee.json.id, amount: '100.00', issue_date: '2026-03-10', description: 'Privileged approval test' });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const approved = await actor.client.req('POST', `/employee-salary-advances/${created.json.advance.id}/approve`, { version: 1 });
      expect(approved.status, JSON.stringify(approved.json)).toBe(200);
      expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND entity_id=$2 AND actor_user_id=$3 AND action=$4', [company, created.json.advance.id, actor.id, 'employee_salary_advance.approve'])).toBe(1);
    },
  );

  it('rejects inactive accounts and memberships, and keeps ordinary users separated', async () => {
    const owner = await h.user('privilege-negative-owner');
    const actor = await h.user('privilege-negative-actor');
    const company = await h.company('privilege-negative', owner.id);
    await h.member(company, actor.id, ['employee_salary_advance.approve']);
    expect(await hasPrivilegedFinancialAuthority(h.db, company, actor.id)).toBe(false);
    await h.q('UPDATE users SET is_system_admin=TRUE,is_active=FALSE WHERE id=$1', [actor.id]);
    expect(await hasPrivilegedFinancialAuthority(h.db, company, actor.id)).toBe(false);
  });
});
