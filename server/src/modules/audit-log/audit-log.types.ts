export interface AuditLog {
  id: string;
  company_id: string;
  actor_user_id: string;
  /** Dot-namespaced action label — e.g. 'fiscal_year.create' */
  action: string;
  /** Entity type name — e.g. 'fiscal_year' */
  entity_type: string;
  entity_id: string;
  /** State snapshot before the change. Null for creation events.
   *  Must never contain passwords, hashes, or secrets. */
  before_data: Record<string, unknown> | null;
  /** State snapshot after the change. Null for deletion events.
   *  Must never contain passwords, hashes, or secrets. */
  after_data: Record<string, unknown> | null;
  reason: string | null;
  created_at: Date;
}

export interface CreateAuditLogInput {
  company_id: string;
  actor_user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
  reason?: string | null;
}
