import { capabilitySensitivity } from './capability-sensitivity';
import {
  AuthorizationPolicyKey,
  targetSystemAdministratorCapabilities,
  targetRoleCapabilities,
  TARGET_AUTHORIZATION_POLICY_VERSION,
} from './authorization-policy';

export interface AuthorizationRoleImpactInput {
  company_id: string;
  role_id: string;
  role_name: string;
  policy_key: AuthorizationPolicyKey;
  current_policy_version: number;
  current_capabilities: readonly string[];
  membership_user_ids: readonly string[];
}

export interface AuthorizationPolicyImpactProjection {
  policy_version: number;
  roles: Array<{
    company_id: string;
    role_id: string;
    role_name: string;
    user_ids: string[];
    current_policy_version: number;
    additional_capabilities: string[];
    additional_sensitive_capabilities: string[];
    additional_critical_capabilities: string[];
    administrative_delegation_changes: string[];
  }>;
  system_administrator_additional_capabilities: string[];
  system_administrator_additional_sensitive_capabilities: string[];
  system_administrator_additional_critical_capabilities: string[];
  affected_user_ids: string[];
}

/** Pure projection function. It accepts snapshots/fixtures and never opens a database connection. */
export function buildAuthorizationPolicyImpactProjection(input: {
  capability_ids: readonly string[];
  roles: readonly AuthorizationRoleImpactInput[];
  system_administrators: readonly { user_id: string; policy_version: number; current_capabilities: readonly string[] }[];
}): AuthorizationPolicyImpactProjection {
  const roles = input.roles.map((role) => {
    const current = new Set(role.current_capabilities);
    const target = targetRoleCapabilities(role.policy_key, input.capability_ids);
    const additional = target.filter((id) => !current.has(id)).sort();
    return {
      company_id: role.company_id,
      role_id: role.role_id,
      role_name: role.role_name,
      user_ids: [...new Set(role.membership_user_ids)].sort(),
      current_policy_version: role.current_policy_version,
      additional_capabilities: additional,
      additional_sensitive_capabilities: additional.filter((id) => capabilitySensitivity(id) === 'sensitive'),
      additional_critical_capabilities: additional.filter((id) => capabilitySensitivity(id) === 'critical'),
      administrative_delegation_changes: additional.filter((id) => id.startsWith('access.')),
    };
  });

  const adminDeltas = input.system_administrators.map((admin) => {
    const target = targetSystemAdministratorCapabilities(input.capability_ids);
    const current = new Set(admin.current_capabilities);
    return { user_id: admin.user_id, additional: target.filter((id) => !current.has(id)).sort() };
  });
  const adminAdditional = [...new Set(adminDeltas.flatMap((entry) => entry.additional))].sort();
  const affected = new Set<string>();
  for (const role of roles) if (role.additional_capabilities.length) role.user_ids.forEach((id) => affected.add(id));
  for (const admin of adminDeltas) if (admin.additional.length) affected.add(admin.user_id);

  return {
    policy_version: TARGET_AUTHORIZATION_POLICY_VERSION,
    roles,
    system_administrator_additional_capabilities: adminAdditional,
    system_administrator_additional_sensitive_capabilities: adminAdditional.filter((id) => capabilitySensitivity(id) === 'sensitive'),
    system_administrator_additional_critical_capabilities: adminAdditional.filter((id) => capabilitySensitivity(id) === 'critical'),
    affected_user_ids: [...affected].sort(),
  };
}
