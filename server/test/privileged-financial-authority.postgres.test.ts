import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionPolicy } from '../src/cli/authorization-policy-transition';
import { startHarness } from './helpers/http-pg';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
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
      const repo = new MembershipRepository(h.db);
      const policyRole = role === 'system_admin' ? undefined : (await h.q<{id: string}>(
        'SELECT id FROM roles WHERE company_id=$1 AND authorization_policy_key=$2', [company, role]))[0]!;
      if (policyRole) {
        await h.q('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [actor.id, company, policyRole.id]);
      } else {
        await h.q('UPDATE users SET is_system_admin=TRUE WHERE id=$1', [actor.id]);
      }
      const operator = policyRole ? await h.user('policy-operator-' + role) : actor;
      if (policyRole) {
        await h.q('UPDATE users SET is_system_admin=TRUE WHERE id=$1', [operator.id]);
        await h.q("INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,'company.create') ON CONFLICT DO NOTHING", [policyRole.id]);
      }
      const { db } = (await h.q('SELECT current_database() AS db'))[0]!;
      const setVersion = (version: number, scope = policyRole ? company : 'global') => transitionPolicy(h.db, [
        db, operator.id, policyRole ? 'role' : 'admin', policyRole?.id ?? actor.id, scope,
        String(1 - version), String(version), 'integration-test',
      ]);
      const stored = policyRole ? (await repo.getRoleCapabilities(policyRole.id)).sort() : [];
      const explicit = stored.filter((id) => id !== 'company.create');
      expect(await repo.getActiveCapabilities(actor.id, company)).toEqual(explicit);
      expect(await hasPrivilegedFinancialAuthority(h.db, foreign, actor.id)).toBe(role === 'system_admin');
      await owner.client.login();
      await actor.client.login();
      if (role === 'system_admin') expect((await actor.client.req('POST', '/auth/switch-company', { companyId: company })).status).toBe(200);

      if (policyRole) {
        await expect(transitionPolicy(h.db, [db, actor.id, 'admin', operator.id, 'global', '0', '1', 'test'])).rejects.toThrow('Active System Administrator');
        await expect(setVersion(1, foreign)).rejects.toThrow('mismatch');
        expect((await actor.client.req('POST', '/companies', { slug: 'stored-global', name: 'Global' })).status).toBe(403);
        expect(await repo.getActiveCapabilities(actor.id, foreign)).toEqual([]);
      }
      await setVersion(1);
      await expect(setVersion(1)).rejects.toThrow('mismatch');
      if (!policyRole) {
        expect((await actor.client.req('PUT', `/admin/users/${actor.id}/system-admin`, { is_system_admin: true })).status).toBe(200);
      }
      const catalog = (await repo.listCapabilities()).sort();
      const expected = policyRole ? catalog.filter((id) => id !== 'company.create') : catalog;
      expect(await repo.getActiveCapabilities(actor.id, company)).toEqual(expected);
      if (policyRole) expect(await repo.getEffectiveRoleCapabilities(policyRole.id)).toEqual(expected);
      expect((await actor.client.req('GET', '/access/memberships')).status).toBe(200);
      let customRoleId: string | undefined;
      if (policyRole) {
        const custom = await actor.client.req('POST', '/access/roles', { name: 'Delegated actions' });
        expect(custom.status).toBe(201);
        customRoleId = custom.json.id;
        expect((await actor.client.req('PUT', `/access/roles/${customRoleId}/capabilities/payroll.accounting.post`)).status).toBe(204);
        expect((await actor.client.req('PATCH', `/companies/${company}`, { name: 'Local management' })).status).toBe(200);
        expect((await actor.client.req('PATCH', `/companies/${foreign}`, { name: 'Foreign management' })).status).toBe(404);
        expect((await actor.client.req('GET', '/admin/users')).status).toBe(403);
        expect((await actor.client.req('POST', '/companies', { slug: 'policy-global', name: 'Global create' })).status).toBe(403);
      }
      const employee = await owner.client.req('POST', '/employees', { employee_number: `PF${role}`, display_name: 'Privilege Test', employment_start: '2026-01-01', employment_end: null });
      expect(employee.status).toBe(201);
      const created = await actor.client.req('POST', '/employee-salary-advances', { employee_id: employee.json.id, amount: '100.00', issue_date: '2026-03-10', description: 'Privileged approval test' });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const approved = await actor.client.req('POST', `/employee-salary-advances/${created.json.advance.id}/approve`, { version: 1 });
      expect(approved.status, JSON.stringify(approved.json)).toBe(200);
      if (role !== 'system_admin') expect((await actor.client.req('POST', '/auth/switch-company', { companyId: foreign })).status).toBe(403);
      await setVersion(0);
      expect(await repo.getActiveCapabilities(actor.id, company)).toEqual(explicit);
      if (policyRole) {
        expect((await actor.client.req('DELETE', `/access/roles/${customRoleId}/capabilities/payroll.accounting.post`)).status).toBe(403);
        expect((await repo.getRoleCapabilities(policyRole.id)).sort()).toEqual(stored);
        expect(await repo.getEffectiveRoleCapabilities(policyRole.id)).toEqual(explicit);
        await h.q('UPDATE memberships SET is_active=FALSE WHERE user_id=$1 AND company_id=$2', [actor.id, company]);
        expect(await repo.getActiveCapabilities(actor.id, company)).toEqual([]);
        expect(await hasPrivilegedFinancialAuthority(h.db, company, actor.id)).toBe(false);
      }
      if (policyRole) {
        expect(await h.count("SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND company_id=$2 AND actor_user_id=$3 AND action LIKE 'authorization.policy.%'", [policyRole.id, company, operator.id])).toBe(2);
      } else {
        expect(await h.q("SELECT action, before_data->>'version' AS old, after_data->>'version' AS new FROM system_audit_log WHERE target_user_id=$1 AND action LIKE 'authorization.policy.%' ORDER BY created_at", [actor.id])).toEqual([
          { action: 'authorization.policy.activate', old: '0', new: '1' },
          { action: 'authorization.policy.rollback', old: '1', new: '0' },
        ]);
        expect(await repo.getActiveCapabilities(actor.id, foreign)).toEqual([]);
        await setVersion(1);
        expect(await repo.getActiveCapabilities(actor.id, foreign)).toEqual(catalog);
      }
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
