import {
  ACCOUNTANT_CAPABILITIES,
  COMPANY_MANAGER_CAPABILITIES,
  FINANCE_MANAGER_DEFAULT_CAPABILITIES,
} from './default-role-capabilities';

export const TARGET_AUTHORIZATION_POLICY_VERSION = 1;
export type AuthorizationPolicyKey = 'accountant' | 'company_manager' | 'finance_manager';
export const PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY = 'payroll.settlement.exception.approve';

/** Existing global wildcard read exceptions preserved for System Admin and company Full Access. */
export const LEGACY_WILDCARD_READ_CAPABILITIES = [
  'payroll.accounting.mapping.view',
  'payroll.accounting.preview',
  'payroll.settlement.view',
] as const;

/** Financial domains are centrally defined here so each route continues using the same capability guard. */
const FINANCIAL_DOMAINS = new Set([
  'accounting', 'annual_close', 'asset', 'audit', 'bank', 'company_accounting_profile',
  'counterparty', 'custody', 'document', 'employee', 'employee_cost', 'fiscal_year',
  'historical', 'invoice', 'monthly_close', 'obligation', 'opening_balance', 'partner', 'payroll',
  'payment', 'personal_payment', 'periodic_adjustment', 'report', 'source_authority',
  'tax_workpaper', 'vat', 'wht_review',
]);

/**
 * Target policy overlay for a versioned standard role. It is only consulted after that
 * role is explicitly moved to policy version 1. Explicit role_capabilities remain stored
 * separately so resetting the version to 0 restores the exact prior permission snapshot.
 */
export function targetRoleCapabilities(key: AuthorizationPolicyKey, capabilityIds: readonly string[]): string[] {
  // Accountant grants remain explicit so company owners can keep them limited and configurable.
  if (key === 'accountant') return [];
  if (key === 'finance_manager') {
    return capabilityIds.filter((id) => (FINANCIAL_DOMAINS.has(id.split('.')[0] ?? '') || id === 'company.view')
      && id !== 'company.create' && id !== PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY).sort();
  }
  // Company Manager receives company functional capabilities. Existing, explicit
  // access.* grants remain in place, while global access delegation and company lifecycle
  // actions stay outside the role; Full Access remains a distinct company role.
  return capabilityIds.filter((id) => !id.startsWith('access.') && id !== 'company.create' && id !== 'company.status.edit'
    && id !== PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY).sort();
}

export function effectiveRoleCapabilities(
  key: AuthorizationPolicyKey | null,
  version: number,
  explicit: readonly string[],
  capabilityIds: readonly string[],
): string[] {
  const result = new Set(explicit);
  if (key && version >= TARGET_AUTHORIZATION_POLICY_VERSION) {
    for (const capability of targetRoleCapabilities(key, capabilityIds)) result.add(capability);
  }
  return [...result].sort();
}

export function isAuthorizationPolicyKey(value: unknown): value is AuthorizationPolicyKey {
  return value === 'accountant' || value === 'company_manager' || value === 'finance_manager';
}

export function targetSystemAdministratorCapabilities(capabilityIds: readonly string[]): string[] {
  // Independent settlement SoD approval is explicitly delegated to a company reviewer; global authority must not auto-approve it.
  return [...new Set(capabilityIds)].filter((id) => id !== PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY).sort();
}

/** Payroll-only authority expressly approved for privileged payroll roles, independent of v1 activation. */
export function privilegedPayrollCapabilities(capabilityIds: readonly string[]): string[] {
  return capabilityIds.filter((id) => (id.startsWith('payroll.') || id === 'bank.view')
    && id !== PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY).sort();
}

/** Canonical current role snapshots used only for projection and impact review. */
export const DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES: Record<AuthorizationPolicyKey, readonly string[]> = {
  accountant: ACCOUNTANT_CAPABILITIES,
  company_manager: COMPANY_MANAGER_CAPABILITIES,
  finance_manager: FINANCE_MANAGER_DEFAULT_CAPABILITIES,
};
