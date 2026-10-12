import { Pool, PoolClient } from 'pg';

/**
 * Effective-dated standard VAT rate lookup (migration 069). Ordinary standard-rated supplies only: historical
 * transitional exceptions are not modelled, so callers must treat "no row" as unsupported and fail closed.
 * All companies currently use the 'SA' jurisdiction (the company table carries no country).
 */
export const DEFAULT_JURISDICTION = 'SA';

export type StandardRate = { jurisdiction: string; rate: string; effective_from: string; effective_to: string | null };

export async function resolveStandardRate(db: Pool | PoolClient, date: string, jurisdiction = DEFAULT_JURISDICTION): Promise<StandardRate | null> {
  const { rows } = await db.query<StandardRate>(
    `SELECT jurisdiction, rate::text AS rate, effective_from::text AS effective_from, effective_to::text AS effective_to
     FROM vat_standard_rates
     WHERE jurisdiction = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR $2::date <= effective_to)`,
    [jurisdiction, date],
  );
  return rows[0] ?? null;
}

/** Exact numeric comparison of two percent strings (e.g. "15" and "15.00"). */
export const sameRate = (a: string, b: string) => Number(a).toFixed(2) === Number(b).toFixed(2);
