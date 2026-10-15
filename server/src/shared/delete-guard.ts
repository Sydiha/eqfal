import type { PoolClient } from 'pg';

/**
 * Shared safety net for permanent deletion of draft/unused records (Delete & Void Phase 3).
 * findReferencingTable() scans the live foreign-key catalog, so a table added by a later migration is covered without code changes.
 * The delete is refused whenever any row in any table still references the record; nothing is ever cascaded into financial data.
 */
export class DeleteBlockedError extends Error {
  constructor(readonly reason: string, readonly table?: string) { super(`Delete blocked: ${reason}`); }
}

export function sendDeleteBlocked(res: { status(code: number): { json(body: unknown): unknown } }, code: string, error: DeleteBlockedError) {
  res.status(409).json({ error: error.message, code, reason: error.reason });
}

/** Returns the first table (schema-stripped) holding a row that references (table, id, companyId), or null. */
export async function findReferencingTable(client: PoolClient, table: string, id: string, companyId: string, ignore: readonly string[] = []): Promise<string | null> {
  const fks = await client.query<{ tbl: string; pairs: { col: string; ref: string }[] }>(
    `SELECT c.conrelid::regclass::text AS tbl,
            json_agg(json_build_object('col', a.attname, 'ref', fa.attname) ORDER BY k.ord) AS pairs
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
      WHERE c.contype = 'f' AND c.confrelid = $1::regclass
      GROUP BY c.oid, c.conrelid`, [table]);
  for (const fk of fks.rows) {
    const name = fk.tbl.replace(/^"?public"?\./, '').replace(/"/g, '');
    if (ignore.includes(name)) continue;
    const where = fk.pairs.map((pair) => `"${pair.col}" = $${pair.ref === 'company_id' ? 2 : 1}`).join(' AND ');
    const hit = await client.query(`SELECT 1 FROM ${fk.tbl} WHERE ${where} LIMIT 1`, [id, companyId]);
    if (hit.rowCount) return name;
  }
  return null;
}
