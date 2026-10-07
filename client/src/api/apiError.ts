/**
 * Shared API error parsing. The server keeps its HTTP status and legacy
 * `error` string and adds an optional stable `code`; screens map codes to
 * AR/EN messages under `errors.*` and never show the raw backend text.
 */

/** `detail` is kept for diagnostics only; the UI never renders it. */
export interface ApiFinding { code: string; count?: number; detail?: unknown }

/** Every stable code introduced/normalized in Task 35D Phase 1 (each needs AR + EN). */
export const PHASE1_ERROR_CODES = [
  'FISCAL_YEAR_CLOSE_BLOCKED',
  'FISCAL_YEAR_OVERLAP',
  'FISCAL_YEAR_ALREADY_CLOSED',
  'FISCAL_YEAR_CLOSED_IMMUTABLE',
  'FISCAL_YEAR_CLOSED',
  'ACCOUNTING_PERIOD_CLOSED',
  'NO_ACTIVE_COMPANY',
  'INVALID_CREDENTIALS',
  'DB_UNAVAILABLE',
  'INVALID_REQUEST_ORIGIN',
  'INVALID_LOGIN_REQUEST',
  'NETWORK_ERROR',
] as const;

export const FISCAL_YEAR_BLOCKER_CODES = [
  'monthly_period_missing', 'monthly_period_open', 'draft_journals', 'unposted_operational_sources',
  'trial_balance_unbalanced', 'unresolved_documents', 'unconfirmed_obligations',
  'unreconciled_bank_transactions', 'pending_periodic_adjustments', 'pending_depreciation',
  'draft_fixed_assets', 'vat_incomplete', 'opening_balances_incomplete', 'partner_ownership_overlap',
] as const;

export const FISCAL_YEAR_WARNING_CODES = [
  'open_receivable_balance', 'open_payable_balance', 'zakat_tax_workpaper_not_ready',
  'wht_review_not_ready', 'partner_ownership_unconfirmed', 'vat_boundary_review',
  'vat_profile_needs_review', 'annual_closing_package_not_approved',
] as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly blockers: ApiFinding[];
  readonly warnings: ApiFinding[];
  readonly fields: Record<string, unknown> | null;
  readonly network: boolean;

  constructor(init: {
    status: number;
    code?: string | null;
    message?: string;
    details?: unknown;
    blockers?: ApiFinding[];
    warnings?: ApiFinding[];
    fields?: Record<string, unknown> | null;
    network?: boolean;
  }) {
    super(init.message ?? `API request failed (${init.status})`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code ?? (init.network ? 'NETWORK_ERROR' : null);
    this.details = init.details;
    this.blockers = init.blockers ?? [];
    this.warnings = init.warnings ?? [];
    this.fields = init.fields ?? null;
    this.network = init.network ?? false;
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function findings(value: unknown): ApiFinding[] {
  if (!Array.isArray(value)) return [];
  const out: ApiFinding[] = [];
  for (const item of value) {
    const entry = asObject(item);
    if (entry && typeof entry.code === 'string') {
      const finding: ApiFinding = { code: entry.code };
      if (typeof entry.count === 'number') finding.count = entry.count;
      if (entry.detail !== undefined) finding.detail = entry.detail;
      out.push(finding);
    }
  }
  return out;
}

/** Build an ApiError from a non-OK response. Never throws; non-JSON bodies yield a status-only error. */
export async function parseApiError(response: Response): Promise<ApiError> {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = asObject(await response.clone().json());
  } catch {
    payload = null; // proxy HTML, empty body, truncated JSON
  }
  return new ApiError({
    status: response.status,
    code: payload && typeof payload.code === 'string' ? payload.code : null,
    message: payload && typeof payload.error === 'string' ? payload.error : undefined,
    details: payload?.details,
    blockers: findings(payload?.blockers),
    warnings: findings(payload?.warnings),
    fields: asObject(payload?.fields),
  });
}

/** Normalize anything thrown by fetch/parse into an ApiError (aborts are rethrown unchanged). */
export function toApiError(reason: unknown): ApiError {
  if (reason instanceof ApiError) return reason;
  return new ApiError({ status: 0, network: true, message: reason instanceof Error ? reason.message : undefined });
}

export const isAbortError = (reason: unknown): boolean => reason instanceof DOMException && reason.name === 'AbortError';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Translated message for a known code, or null so the caller can keep its own
 * generic fallback. 503 without a code is treated as DB_UNAVAILABLE.
 */
export function apiErrorMessage(error: ApiError, t: Translate): string | null {
  const code = error.network ? 'NETWORK_ERROR' : error.code ?? (error.status === 503 ? 'DB_UNAVAILABLE' : null);
  if (!code) return null;
  const key = `errors.${code}`;
  const text = t(key);
  return text === key ? null : text;
}

export function findingMessage(kind: 'blockers' | 'warnings', finding: ApiFinding, t: Translate): string {
  const key = `errors.${kind}.${finding.code}`;
  const text = t(key, { count: finding.count ?? 0 });
  return text === key ? t(`errors.${kind}.unknown`, { count: finding.count ?? 0 }) : text;
}
