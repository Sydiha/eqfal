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
  is_full_access: boolean;
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

/** Membership row enriched for administration screens (read-only display fields). */
export interface MembershipListItem extends Membership {
  user_email: string;
  user_is_active: boolean;
  role_name: string | null;
  /** Set when listed for an actor: whether that actor may change this member (mirrors the server rule). */
  can_manage?: boolean;
}

/** Role row with its explicit capability ids (Full Access roles hold every capability implicitly). */
export interface RoleListItem extends Role {
  capabilities: string[];
  /** Set when listed for an actor: may be assigned to others / may have its capabilities edited. */
  assignable?: boolean;
  editable?: boolean;
}

/** How a membership's effective capabilities arise (distinct from the role's own capability rows). */
export type EffectiveSource = 'role' | 'full_access_wildcard' | 'system_admin_global' | 'none';

/** One company entry of the consolidated user view. Only companies the actor is authorized to see are ever included. */
export interface UserCompanyAccess {
  membership_id: string;
  company_id: string;
  company_name: string;
  company_name_ar: string | null;
  company_is_active: boolean;
  is_active: boolean;
  is_current_company: boolean;
  role: { id: string; name: string; is_full_access: boolean } | null;
  /** Explicit role_capabilities rows (empty for the Full Access wildcard role). */
  role_capabilities: string[];
  /** What the user can actually do in this company right now (membership, company and global authority applied). */
  effective_capabilities: string[];
  effective_source: EffectiveSource;
}

export interface MembershipDetails {
  user: { id: string; email: string; is_active: boolean; is_system_admin: boolean };
  companies: UserCompanyAccess[];
}

export interface RoleCloneResult {
  role: Role;
  copied_capabilities: string[];
  /** Administrative capabilities of the source that were NOT copied; granting them stays an explicit, ceiling-checked step. */
  omitted_capabilities: string[];
}
