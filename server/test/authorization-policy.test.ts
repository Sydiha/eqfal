import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCOUNTANT_CAPABILITIES, COMPANY_MANAGER_CAPABILITIES, FINANCE_MANAGER_DEFAULT_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';
import { effectiveRoleCapabilities, targetRoleCapabilities, targetSystemAdministratorCapabilities } from '../src/modules/memberships/authorization-policy';
import { buildAuthorizationPolicyImpactProjection } from '../src/modules/memberships/authorization-policy-impact';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const catalog = [
  ...new Set([
    ...ACCOUNTANT_CAPABILITIES,
    ...COMPANY_MANAGER_CAPABILITIES,
    ...FINANCE_MANAGER_DEFAULT_CAPABILITIES,
    'access.full_access.grant', 'company.create', 'company.status.edit', 'company.view',
    'payroll.view', 'payroll.edit', 'payroll.approve', 'payroll.accounting.mapping.view',
    'payroll.accounting.mapping.manage', 'payroll.accounting.preview', 'payroll.accounting.post', 'payroll.settlement.view', 'payroll.settlement.create',
    'invoice.approve', 'invoice.cancel', 'access.user.password.reset', 'payroll.settlement.exception.approve',
  ]),
].sort();

describe('versioned authorization policy', () => {
  it('keeps version zero roles exactly at their stored grants', () => {
    const explicit = ['accounting.view', 'access.view'];
    expect(effectiveRoleCapabilities('company_manager', 0, explicit, catalog)).toEqual([...explicit].sort());
    expect(effectiveRoleCapabilities('finance_manager', 0, explicit, catalog)).toEqual([...explicit].sort());
    expect(effectiveRoleCapabilities('accountant', 0, explicit, catalog)).toEqual([...explicit].sort());
  });

  it('adds company functional authority without adding access delegation or global company lifecycle authority', () => {
    const target = targetRoleCapabilities('company_manager', catalog);
    expect(target).toContain('accounting.journal.post');
    expect(target).toContain('payroll.approve');
    expect(target).toContain('invoice.approve');
    expect(target).not.toContain('access.full_access.grant');
    expect(target).not.toContain('access.role.capability.grant');
    expect(target).not.toContain('company.create');
    expect(target).not.toContain('company.status.edit');
    expect(target).not.toContain('payroll.settlement.exception.approve');
    expect(effectiveRoleCapabilities('company_manager', 1, ['access.view'], catalog)).toContain('access.view');
  });

  it('adds financial authority including payroll without adding access administration', () => {
    const target = targetRoleCapabilities('finance_manager', catalog);
    for (const id of ['accounting.journal.post', 'payroll.edit', 'payroll.approve', 'payroll.accounting.post', 'invoice.approve']) expect(target).toContain(id);
    expect(target).not.toContain('access.view');
    expect(target).not.toContain('access.full_access.grant');
    expect(target).not.toContain('company.create');
    expect(target).not.toContain('payroll.settlement.exception.approve');
  });

  it('keeps Accountant grants explicit and configurable under every policy version', () => {
    const explicit = ['accounting.view', 'accounting.journal.create'];
    expect(targetRoleCapabilities('accountant', catalog)).toEqual([]);
    expect(effectiveRoleCapabilities('accountant', 1, explicit, catalog)).toEqual([...explicit].sort());
  });

  it('keeps independently approved settlement exceptions outside the global System Administrator policy', () => {
    expect(targetSystemAdministratorCapabilities(catalog)).toEqual(catalog.filter((id) => id !== 'payroll.settlement.exception.approve'));
  });

  it('does not change Full Access semantics when a corrupt role row carries a policy key', async () => {
    const queryRows = [
      { capability_id: 'payroll.accounting.post', currently_authorized: false, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 1, role_is_full_access: true },
      { capability_id: 'payroll.accounting.mapping.view', currently_authorized: true, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 1, role_is_full_access: true },
      { capability_id: 'payroll.accounting.preview', currently_authorized: true, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 1, role_is_full_access: true },
      { capability_id: 'payroll.settlement.view', currently_authorized: true, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 1, role_is_full_access: true },
      { capability_id: 'accounting.view', currently_authorized: true, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 1, role_is_full_access: true },
    ];
    const fakePool = { query: async () => ({ rows: queryRows }) } as never;
    const result = await new MembershipRepository(fakePool).getActiveCapabilities('user', 'company');
    expect(result).toEqual(['accounting.view', 'payroll.accounting.mapping.view', 'payroll.accounting.preview', 'payroll.settlement.view']);
  });

  it('does not grant inactive policy overlays and resolves activated company roles only in their selected company', async () => {
    const base = {
      is_system_admin: false, system_admin_policy_version: 0, role_policy_key: 'company_manager', role_policy_version: 0,
      role_is_full_access: false,
    };
    const current = [
      { ...base, capability_id: 'company.view', currently_authorized: true },
      { ...base, capability_id: 'payroll.approve', currently_authorized: false },
    ];
    const inactive = await new MembershipRepository({ query: async () => ({ rows: current }) } as never).getActiveCapabilities('u', 'company-a');
    expect(inactive).toEqual(['company.view']);

    const activated = current.map((row) => ({ ...row, role_policy_version: 1 }));
    const authorized = await new MembershipRepository({ query: async () => ({ rows: activated }) } as never).getActiveCapabilities('u', 'company-a');
    expect(authorized).toContain('payroll.approve');
    const foreignCompany = await new MembershipRepository({ query: async () => ({ rows: [] }) } as never).getActiveCapabilities('u', 'company-b');
    expect(foreignCompany).toEqual([]);
  });

  it('resolves activated System Administrator policy to every registered capability', async () => {
    const rows = catalog.map((capability_id) => ({
      capability_id, currently_authorized: capability_id === 'accounting.view', is_system_admin: true,
      system_admin_policy_version: 1, role_policy_key: null, role_policy_version: 0, role_is_full_access: false,
    }));
    const resolved = await new MembershipRepository({ query: async () => ({ rows }) } as never).getActiveCapabilities('admin', 'company-a');
    expect(resolved).toEqual(catalog.filter((id) => id !== 'payroll.settlement.exception.approve'));
  });

  it('does not expose settlement exception approval to a System Administrator through an explicit role grant', async () => {
    const rows = [{
      capability_id: 'payroll.settlement.exception.approve', currently_authorized: true, is_system_admin: true,
      system_admin_policy_version: 0, role_policy_key: null, role_policy_version: 0, role_is_full_access: false,
    }];
    const resolved = await new MembershipRepository({ query: async () => ({ rows }) } as never).getActiveCapabilities('admin', 'company-a');
    expect(resolved).toEqual([]);
  });

  it('does not expose settlement exception approval to Full Access through an explicit row or wildcard', async () => {
    const rows = [{
      capability_id: 'payroll.settlement.exception.approve', currently_authorized: true, is_system_admin: false,
      system_admin_policy_version: 0, role_policy_key: null, role_policy_version: 0, role_is_full_access: true,
    }];
    const resolved = await new MembershipRepository({ query: async () => ({ rows }) } as never).getActiveCapabilities('full-access', 'company-a');
    expect(resolved).toEqual([]);
  });

  it('projects fixture role/member deltas without database access', () => {
    const projection = buildAuthorizationPolicyImpactProjection({
      capability_ids: catalog,
      roles: [{
        company_id: 'company-a', role_id: 'manager-a', role_name: 'Company Manager', policy_key: 'company_manager',
        current_policy_version: 0, current_capabilities: ['access.view', 'company.view'], membership_user_ids: ['user-a', 'user-a'],
      }],
      system_administrators: [{ user_id: 'admin', policy_version: 0, current_capabilities: ['accounting.view'] }],
    });
    expect(projection.roles[0]!.user_ids).toEqual(['user-a']);
    expect(projection.roles[0]!.additional_capabilities).toContain('payroll.approve');
    expect(projection.roles[0]!.administrative_delegation_changes).toEqual([]);
    expect(projection.affected_user_ids).toEqual(['admin', 'user-a']);
    expect(projection.system_administrator_additional_capabilities).toContain('payroll.accounting.post');
  });

  it('migration tags standard roles at version zero and does not write grants or memberships', () => {
    const sql = readFileSync(new URL('../migrations/122_versioned_authorization_policy.sql', import.meta.url), 'utf8');
    expect(sql).toContain('authorization_policy_version SMALLINT NOT NULL DEFAULT 0');
    expect(sql).toContain('system_admin_policy_version SMALLINT NOT NULL DEFAULT 0');
    expect(sql).toContain("SET authorization_policy_key = 'finance_manager'");
    expect(sql).toContain("name IN ('Accountant', 'accountant')");
    expect(sql).toContain("name IN ('Finance Manager', 'finance_manager')");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
    expect(sql).not.toMatch(/UPDATE\s+memberships/i);
    expect(sql).not.toMatch(/SET\s+(?:authorization_policy_version|system_admin_policy_version)\s*=\s*1/i);
  });
});
