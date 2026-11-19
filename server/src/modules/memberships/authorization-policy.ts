import {
  ACCOUNTANT_CAPABILITIES,
  COMPANY_MANAGER_CAPABILITIES,
  FINANCE_MANAGER_DEFAULT_CAPABILITIES,
} from './default-role-capabilities';

export const TARGET_AUTHORIZATION_POLICY_VERSION = 1;
export type AuthorizationPolicyKey = 'accountant' | 'company_manager' | 'finance_manager';
export const PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY = 'payroll.settlement.exception.approve';

/** Existing wildcard read exceptions for the technical Full Access role. */
export const LEGACY_WILDCARD_READ_CAPABILITIES = [
  'payroll.accounting.mapping.view',
  'payroll.accounting.preview',
  'payroll.settlement.view',
] as const;

/** Both company managers have the same company authority. Company creation is system-wide. */
export function targetRoleCapabilities(key: AuthorizationPolicyKey, capabilityIds: readonly string[]): string[] {
  if (key === 'accountant') return [];
  return capabilityIds.filter((id) => id !== 'company.create').sort();
}

export function effectiveRoleCapabilities(
  key: AuthorizationPolicyKey | null,
  version: number,
  explicit: readonly string[],
  capabilityIds: readonly string[],
): string[] {
  if (version === TARGET_AUTHORIZATION_POLICY_VERSION && (key === 'finance_manager' || key === 'company_manager')) {
    return targetRoleCapabilities(key, capabilityIds);
  }
  return [...new Set(explicit)].sort();
}

export function isAuthorizationPolicyKey(value: unknown): value is AuthorizationPolicyKey {
  return value === 'accountant' || value === 'company_manager' || value === 'finance_manager';
}

export function targetSystemAdministratorCapabilities(capabilityIds: readonly string[]): string[] {
  return [...new Set(capabilityIds)].sort();
}

/** Canonical current role snapshots used only for projection and impact review. */
export const DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES: Record<AuthorizationPolicyKey, readonly string[]> = {
  accountant: ACCOUNTANT_CAPABILITIES,
  company_manager: COMPANY_MANAGER_CAPABILITIES,
  finance_manager: FINANCE_MANAGER_DEFAULT_CAPABILITIES,
};
