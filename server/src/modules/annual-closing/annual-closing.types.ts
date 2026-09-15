export type ReadinessState = 'ready' | 'needs_review' | 'blocked' | 'not_started' | 'not_applicable';

export interface AnnualClosingDomain {
  ready: boolean;
  blocker_count: number;
  status: ReadinessState;
  summary: Record<string, string | number | boolean>;
}

export interface AnnualClosingResponse {
  fiscal_year: { id: string; start_date: string; end_date: string; status: string };
  ready: boolean;
  blocker_count: number;
  domains: Record<string, AnnualClosingDomain>;
  financial_statements_readiness: { status: 'ready' | 'needs_review'; label: string; label_ar: string };
  zakat_readiness: { status: 'not_started' | 'needs_review' | 'blocked' | 'ready'; tax_path?: string; blockers?: string[] };
  package_manifest: Array<{ section: string; status: ReadinessState; blocker_count?: number; source: string }>;
}
