import type { PoolClient } from 'pg';

/**
 * The approved payroll SoD override is determined from persisted identity and
 * company membership, never from a display role, Full Access, or client claims.
 * Capability guards still authorize each payroll operation independently.
 */
export async function hasPrivilegedPayrollSodAuthority(client: Pick<PoolClient, 'query'>, companyId: string, actorId: string): Promise<boolean> {
  const result = await client.query<{ authorized: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id=$2 AND u.is_active=TRUE AND (
        u.is_system_admin=TRUE OR EXISTS (
          SELECT 1 FROM memberships m
          JOIN roles r ON r.id=m.role_id AND r.company_id=m.company_id
          WHERE m.user_id=u.id AND m.company_id=$1 AND m.is_active=TRUE
            AND r.is_full_access=FALSE
            AND r.authorization_policy_key IN ('company_manager','finance_manager')
        )
      )
    ) AS authorized`, [companyId, actorId]);
  return result.rows[0]?.authorized === true;
}
