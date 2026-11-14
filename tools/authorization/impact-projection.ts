import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capabilitySensitivity } from '../../server/src/modules/memberships/capability-sensitivity';
import { buildAuthorizationPolicyImpactProjection } from '../../server/src/modules/memberships/authorization-policy-impact';
import { DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES } from '../../server/src/modules/memberships/authorization-policy';

const root = resolve(process.cwd());
const migrationsDir = join(root, 'server/migrations');
const migrationFiles = readdirSync(migrationsDir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
const capabilityPattern = /'([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)'/g;
const capabilityIds = new Set<string>();
for (const file of migrationFiles) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  for (const block of sql.matchAll(/INSERT\s+INTO\s+capabilities\b[\s\S]*?;/gi)) {
    for (const match of block[0].matchAll(capabilityPattern)) capabilityIds.add(match[1]!);
  }
}
for (const caps of Object.values(DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES)) caps.forEach((id) => capabilityIds.add(id));

// Existing migrations leave sensitive payroll actions out of the wildcard. The central resolver separately
// preserves the checked-in payroll read exceptions (mapping.view, preview, settlement.view).
const currentSystemAdminExceptions = new Set([
  'payroll.approve',
  'payroll.accounting.mapping.manage',
  'payroll.accounting.post',
  'payroll.settlement.create',
]);
const catalog = [...capabilityIds].sort();
const manager = DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES.company_manager;
const finance = DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES.finance_manager;
const accountant = DEFAULT_AUTHORIZATION_ROLE_CAPABILITIES.accountant;
const projection = buildAuthorizationPolicyImpactProjection({
  capability_ids: catalog,
  roles: [
    { company_id: 'fixture-company-a', role_id: 'fixture-company-manager', role_name: 'Company Manager', policy_key: 'company_manager', current_policy_version: 0, current_capabilities: manager, membership_user_ids: ['fixture-user-manager'] },
    { company_id: 'fixture-company-a', role_id: 'fixture-finance-manager', role_name: 'Finance Manager', policy_key: 'finance_manager', current_policy_version: 0, current_capabilities: finance, membership_user_ids: ['fixture-user-finance'] },
    { company_id: 'fixture-company-a', role_id: 'fixture-accountant', role_name: 'Accountant', policy_key: 'accountant', current_policy_version: 0, current_capabilities: accountant, membership_user_ids: ['fixture-user-accountant'] },
  ],
  system_administrators: [{
    user_id: 'fixture-system-admin', policy_version: 0,
    current_capabilities: catalog.filter((id) => !currentSystemAdminExceptions.has(id)),
  }],
});

function capabilityLists(items: readonly string[]): string {
  return items.length ? items.map((id) => `\`${id}\``).join(', ') : 'None';
}
function riskList(items: readonly string[]): string {
  return capabilityLists(items);
}

const lines = [
  '# Phase 1 Authorization Impact Projection',
  '',
  '> **Code-based projection only. Real company, role-row, membership, and user impact is PENDING an approved read-only database or snapshot.**',
  '',
  `Generated from ${migrationFiles.length} checked-in migrations and canonical default role definitions. The fixture models one membership for each standard role and one global System Administrator; fixture identifiers are synthetic. No database is read.`,
  '',
  '## Projected role impact',
  '',
  '| Standard role | Capability additions per canonical role | Fixture memberships gaining capabilities | Newly granted sensitive/critical capabilities | Administrative delegation additions |',
  '|---|---:|---:|---|---|',
  ...projection.roles.map((role) => {
    const sensitive = [...role.additional_sensitive_capabilities, ...role.additional_critical_capabilities];
    return `| ${role.role_name} | ${role.additional_capabilities.length} | ${role.user_ids.length} | ${riskList(sensitive)} | ${riskList(role.administrative_delegation_changes)} |`;
  }),
  '',
  '## System Administrator projection',
  '',
  `Current checked-in migrations exclude ${projection.system_administrator_additional_capabilities.length} registered capabilities from the legacy wildcard. Target version 1 adds: ${capabilityLists(projection.system_administrator_additional_capabilities)}.`,
  `Sensitive additions: ${capabilityLists(projection.system_administrator_additional_sensitive_capabilities)}.`,
  `Critical additions: ${capabilityLists(projection.system_administrator_additional_critical_capabilities)}.`,
  '',
  '## Role detail',
  '',
  ...projection.roles.map((role) => {
    const sensitive = [...role.additional_sensitive_capabilities, ...role.additional_critical_capabilities];
    return `### ${role.role_name}\n\nAdditional capabilities (${role.additional_capabilities.length}): ${capabilityLists(role.additional_capabilities)}\n\nSensitive/critical additions: ${capabilityLists(sensitive)}\n\nAdministrative delegation changes: ${capabilityLists(role.administrative_delegation_changes)}\n`;
  }),
  '## Scope and activation',
  '',
  '- Existing role and System Administrator policy versions are migrated as `0`; current stored role grants and memberships are unchanged.',
  '- Newly provisioned standard roles are tagged with their policy key but remain version `0`; new users and new companies do not receive target-policy additions before activation.',
  '- Full Access remains on its existing wildcard and explicit payroll exception. Phase 1 does not change payroll SoD checks.',
  '- Later activation must be a separately owner-approved, audited change to selected `authorization_policy_version` / `system_admin_policy_version` rows after a verified database impact report. Rollback sets the selected version back to `0`; stored capability rows remain untouched.',
  '- The projections use canonical code defaults. Existing database role customizations, actual companies, and assigned users may differ; inspect those from an approved read-only snapshot before activation.',
  '',
];

// Verify that the displayed risk classification follows the same capability metadata used by the UI.
for (const role of projection.roles) {
  for (const id of [...role.additional_sensitive_capabilities, ...role.additional_critical_capabilities]) {
    if (capabilitySensitivity(id) === 'normal') throw new Error(`Projection risk mismatch for ${id}`);
  }
}
const output = join(root, 'docs/authorization/PHASE_1_IMPACT_PROJECTION.md');
mkdirSync(join(root, 'docs/authorization'), { recursive: true });
writeFileSync(output, lines.join('\n'));
console.log(`Wrote ${output}`);
console.log(`Catalog: ${catalog.length} capability IDs; fixture users gaining authority: ${projection.affected_user_ids.length}`);
