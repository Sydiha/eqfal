import type { PoolClient } from 'pg';

/**
 * Financial actor-separation authority is determined from persisted identity and
 * company membership, never from a display role, Full Access, or client claims.
 * Capability guards still authorize each operation independently.
 */
export async function hasPrivilegedFinancialAuthority(client: Pick<PoolClient, 'query'>, companyId: string, actorId: string): Promise<boolean> {
  const result = await client.query<{ authorized: boolean }>(
    'SELECT has_privileged_financial_authority($1,$2) AS authorized', [companyId, actorId]);
  return result.rows[0]?.authorized === true;
}
