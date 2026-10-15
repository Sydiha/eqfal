/**
 * Risk-based confirmation for granting authority (owner decision 2026-10-15). UX only: the server enforces every
 * grant (capability, ceiling, Full Access authority) whatever the user confirms here.
 */
export type CapabilitySensitivity = 'sensitive' | 'critical';
export type SensitivityMap = Readonly<Record<string, CapabilitySensitivity>>;
export type GrantRisk = 'normal' | 'sensitive' | 'critical' | 'full_access';

export interface GrantImpact {
  risk: GrantRisk;
  /** Newly granted capabilities that need a warning (sensitive or critical), critical first. Unchanged and revoked ones never appear. */
  flagged: { id: string; level: CapabilitySensitivity }[];
}

/** Capabilities in next that are not in current (revocations and unchanged permissions are ignored). */
export function newlyGranted(current: readonly string[], next: readonly string[]): string[] {
  const had = new Set(current);
  return [...new Set(next)].filter((id) => !had.has(id));
}

export function grantImpact(granted: readonly string[], sensitivity: SensitivityMap, grantsFullAccess = false): GrantImpact {
  const flagged = granted
    .filter((id) => sensitivity[id])
    .map((id) => ({ id, level: sensitivity[id]! }))
    .sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'critical' ? -1 : 1));
  const risk: GrantRisk = grantsFullAccess ? 'full_access'
    : flagged.some((f) => f.level === 'critical') ? 'critical'
      : flagged.length > 0 ? 'sensitive' : 'normal';
  return { risk, flagged };
}

/** Explicit confirmation (an "I understand" tick) is required for critical authority and for Full Access. */
export const needsExplicitConfirmation = (risk: GrantRisk) => risk === 'critical' || risk === 'full_access';

export interface RoleLike { id: string; is_full_access: boolean; capabilities: readonly string[] }

/**
 * Impact of moving a member from currentRole to nextRole: only authority the member does not already have counts.
 * Moving onto Full Access is always the strongest warning unless the member already holds Full Access.
 */
export function roleChangeImpact(currentRole: RoleLike | null, nextRole: RoleLike, allCapabilities: readonly string[], sensitivity: SensitivityMap): GrantImpact & { granted: string[] } {
  const effective = (role: RoleLike | null) => (!role ? [] : role.is_full_access ? allCapabilities : role.capabilities);
  const granted = newlyGranted(effective(currentRole), effective(nextRole));
  const toFullAccess = nextRole.is_full_access && !currentRole?.is_full_access;
  return { ...grantImpact(granted, sensitivity, toFullAccess), granted };
}
