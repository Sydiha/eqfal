import type { PoolClient } from 'pg';
import { lockVatPeriodScope } from '../vat/vat.router';
import { lockAccountingRange } from '../monthly-close/accounting-period.guard';
import { ProfileConflictError } from './company-accounting-profile.types';

/**
 * Lock order for anything that changes which accounting profile is effective (ordinary approval, correction) and for the VAT writers
 * that take the shared profile lock. It extends the cut-over activation order and the project order "fiscal-year row -> document row ->
 * VAT month -> accounting month":
 *   1. source-authority:{co}                      (cut-over activation takes it first)
 *   2. profile/company lock hashtext(company)     (exclusive here; shared in VAT writers; also taken by fiscal-year create/update AFTER the
 *                                                  fiscal-year row, so writers take the shared lock after any fiscal-year row lock)
 *   3. profile rows FOR UPDATE (ascending id)
 *   4. vat-periods:{co}, then vat-period:{co}:{YYYY-MM} ascending
 *   5. accounting-period:{co}:{YYYY-MM} ascending
 */
export const lockSourceAuthority = (client: Pick<PoolClient, 'query'>, companyId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
export const lockCompanyProfile = (client: Pick<PoolClient, 'query'>, companyId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId]);
/** Shared mode of the same key: VAT writers with free tax dates take it so a correction can never interleave with them beyond the month locks. */
export const lockCompanyProfileShared = (client: Pick<PoolClient, 'query'>, companyId: string) =>
  client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [companyId]);

export const MAX_CORRECTION_LOCK_MONTHS = 60;
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/**
 * Month locks for a correction window [from, H]. H = MIN(effective_to, last fiscal-year end): journals and VAT periods are bounded by a
 * fiscal year, and fiscal-year creation shares the company lock held by the caller, so H cannot change during the transaction.
 * Free tax dates beyond H are covered by the shared lock in the VAT writers. Refuses (before taking any month lock) beyond 60 months.
 */
export async function lockCorrectionWindow(client: PoolClient, companyId: string, from: string, to: string | null): Promise<string> {
  const lastYear = (await client.query<{ h: string | null }>('SELECT MAX(end_date)::text AS h FROM fiscal_years WHERE company_id=$1', [companyId])).rows[0]!.h;
  let horizon = lastYear && lastYear > from ? lastYear : from;
  if (to && to < horizon) horizon = to;
  if (monthIndex(horizon) - monthIndex(from) + 1 > MAX_CORRECTION_LOCK_MONTHS) {
    throw new CorrectionWindowTooLargeError();
  }
  await lockVatPeriodScope(companyId, from, horizon, client);
  await lockAccountingRange(companyId, from, horizon, client);
  return horizon;
}

export class CorrectionWindowTooLargeError extends ProfileConflictError {
  constructor() { super(`PROFILE_CORRECTION_WINDOW_TOO_LARGE: the profile period spans more than ${MAX_CORRECTION_LOCK_MONTHS} months of fiscal years`); }
}
