/**
 * Risk levels for granting authority (owner decision 2026-10-15). Single source for the administration UI warnings;
 * served by GET /access/capabilities and GET /admin/capabilities. Classification only: it never authorizes anything.
 * Grant authorization is always enforced server-side by capability, ceiling and Full Access rules.
 *   normal    - ordinary permission, no confirmation
 *   sensitive - financial approval or money/accounting-impacting action: confirm the impact
 *   critical  - closing/reopening, posting, or high-impact access administration: prominent warning + explicit confirmation
 * Full Access (a role, not a capability) always gets the strongest warning in the UI.
 */
export type CapabilitySensitivity = 'normal' | 'sensitive' | 'critical';

const CRITICAL = new Set([
  'access.full_access.grant',
  'access.manage',
  'access.membership.role.assign',
  'access.role.capability.grant',
  'accounting.journal.post',
  'annual_close.package.finalize',
  'company.create',
  'company.status.edit',
  'fiscal_year.close',
  'monthly_close.close',
  'monthly_close.reopen',
  'periodic_adjustment.post',
  'vat.close',
  'vat.reopen',
]);

const SENSITIVE_EXACT = new Set([
  'access.membership.create',
  'access.membership.status.edit',
  'access.role.capability.revoke',
  'access.role.create',
  'accounting.chart.create',
  'accounting.chart.edit',
  'accounting.journal.create',
  'accounting.journal.edit',
  'asset.dispose',
  'bank.reconcile',
  'fiscal_year.create',
  'fiscal_year.edit',
  'invoice.cancel',
  'document.delete',
  'invoice.delete',
  'accounting.journal.delete',
  'periodic_adjustment.delete',
  'bank.import.delete',
  'counterparty.delete',
  'partner.delete',
  'obligation.cancel',
  'obligation.confirm',
  'obligation.settle',
  'obligation.settlement.create',
  'obligation.settlement.remove',
  'partner.ownership.confirm',
  'payment.settle',
]);

export function capabilitySensitivity(id: string): CapabilitySensitivity {
  if (CRITICAL.has(id)) return 'critical';
  if (SENSITIVE_EXACT.has(id) || /\.(approve|adjust_approve)$/.test(id) || id.endsWith('.manage')) return 'sensitive';
  return 'normal';
}

export function sensitivityMap(ids: readonly string[]): Record<string, Exclude<CapabilitySensitivity, 'normal'>> {
  const out: Record<string, Exclude<CapabilitySensitivity, 'normal'>> = {};
  for (const id of ids) {
    const level = capabilitySensitivity(id);
    if (level !== 'normal') out[id] = level;
  }
  return out;
}
