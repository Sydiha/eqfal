import type { Pool } from 'pg';

export interface AuditLogFilters {
  q?: string;
  action?: string;
  entity_type?: string;
  entity_id?: string;
  actor_user_id?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface AuditLogRow {
  id: string;
  created_at: Date;
  actor_user_id: string;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  company_id: string;
  company_name: string;
  company_name_ar: string | null;
  reason: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Read-only audit log search. The company scope is a mandatory first argument and is
 * always the first bound parameter: callers can never widen it through filters.
 */
export async function searchAuditLog(pool: Pick<Pool, 'query'>, companyId: string, f: AuditLogFilters) {
  const where = ['a.company_id = $1'];
  const params: unknown[] = [companyId];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (f.action) add(`a.action = ?`, f.action);
  if (f.entity_type) add(`a.entity_type = ?`, f.entity_type);
  if (f.entity_id) add(`a.entity_id = ?`, f.entity_id);
  if (f.actor_user_id) add(`a.actor_user_id = ?`, f.actor_user_id);
  if (f.from) add(`a.created_at >= ?::date`, f.from);
  if (f.to) add(`a.created_at < (?::date + 1)`, f.to);
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    const p = `$${params.length}`;
    where.push(`(a.action ILIKE ${p} OR a.entity_type ILIKE ${p} OR a.entity_id::text ILIKE ${p} OR COALESCE(a.reason, '') ILIKE ${p} OR COALESCE(u.email, '') ILIKE ${p})`);
  }

  const filterSql = `FROM audit_log a
       JOIN companies c ON c.id = a.company_id
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(' AND ')}`;
  const [count, page] = await Promise.all([
    pool.query<{ total: string }>(`SELECT COUNT(*)::text AS total ${filterSql}`, params),
    pool.query<AuditLogRow>(
      `SELECT a.id, a.created_at, a.actor_user_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id,
              a.company_id, c.name AS company_name, c.name_ar AS company_name_ar, a.reason, a.before_data, a.after_data
         ${filterSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    ),
  ]);
  return { total: Number(count.rows[0]?.total ?? 0), entries: page.rows };
}

/** Distinct values for the filter dropdowns, scoped to one company. */
export async function auditLogFacets(pool: Pick<Pool, 'query'>, companyId: string) {
  const [actions, entityTypes, actors] = await Promise.all([
    pool.query<{ v: string }>(`SELECT DISTINCT action AS v FROM audit_log WHERE company_id = $1 ORDER BY 1`, [companyId]),
    pool.query<{ v: string }>(`SELECT DISTINCT entity_type AS v FROM audit_log WHERE company_id = $1 ORDER BY 1`, [companyId]),
    pool.query<{ id: string; email: string | null }>(
      `SELECT DISTINCT a.actor_user_id AS id, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.company_id = $1 ORDER BY 2`, [companyId]),
  ]);
  return { actions: actions.rows.map((r) => r.v), entity_types: entityTypes.rows.map((r) => r.v), actors: actors.rows };
}
