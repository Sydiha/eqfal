/**
 * Capability — a named operational action, company-agnostic.
 * Examples: 'invoice.create', 'report.view', 'journal.approve'
 */
export interface Capability {
  id: string;
}

/**
 * Role — scoped to a single company.
 * A role in company A is independent of any role in company B.
 */
export interface Role {
  id: string;
  company_id: string;
  name: string;
  created_at: Date;
}

/**
 * Membership — binds a user to a company with an optional role.
 * is_active = false blocks all authorization for this membership
 * without touching the underlying user account.
 */
export interface Membership {
  id: string;
  user_id: string;
  company_id: string;
  role_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMembershipInput {
  user_id: string;
  company_id: string;
}

export interface CreateRoleInput {
  company_id: string;
  name: string;
}
