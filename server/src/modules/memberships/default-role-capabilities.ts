/**
 * Canonical default role capability matrix (Viewer, Accountant, Finance Manager, Company Manager).
 *
 * Single TypeScript source of truth used by company provisioning and by tests.
 * Migration 059 is self-contained SQL and intentionally does NOT import this
 * module; a contract test parses the SQL and asserts exact set equality.
 *
 * Hierarchy: Viewer is a subset of Accountant, which is a subset of Finance Manager.
 * Full Access is not listed here: it resolves every registered capability dynamically
 * (roles.is_full_access) and has no explicit role_capabilities rows.
 * Viewer, Accountant and Finance Manager hold no access.* capability. Company Manager (migration 075) is the
 * conservative company administrator described below.
 */

export const VIEWER_CAPABILITIES: readonly string[] = [
  'accounting.view',
  'annual_close.view',
  'annual_close.package.view',
  'asset.view',
  'audit.view',
  'bank.view',
  'company.view',
  'company_accounting_profile.view',
  'custody.view',
  'document.view',
  'fiscal_year.view',
  'monthly_close.view',
  'obligation.view',
  'opening_balance.view',
  'partner.view',
  'periodic_adjustment.view',
  'report.view',
  'tax_workpaper.view',
  'vat.view',
  'wht_review.view',
];

export const ACCOUNTANT_ADDITIONAL_CAPABILITIES: readonly string[] = [
  'accounting.journal.create',
  'accounting.journal.edit',
  'accounting.journal.post',
  'asset.create',
  'asset.edit',
  'bank.import',
  'bank.match',
  'bank.reconcile',
  'counterparty.create',
  'counterparty.edit',
  'document.edit',
  'document.upload',
  'obligation.create',
  'obligation.edit',
  'obligation.confirm',
  'obligation.settlement.create',
  'opening_balance.item.create',
  'opening_balance.item.edit',
  'opening_balance.item.delete',
  'partner.create',
  'partner.edit',
  'periodic_adjustment.create',
  'periodic_adjustment.edit',
  'periodic_adjustment.post',
  'periodic_adjustment.submit',
  'vat.review',
];

export const FINANCE_MANAGER_ADDITIONAL_CAPABILITIES: readonly string[] = [
  'accounting.chart.create',
  'accounting.chart.edit',
  'asset.approve',
  'asset.cancel',
  'asset.dispose',
  'asset.estimate_change.approve',
  'asset.estimate_change.create',
  'asset.estimate_change.review',
  'company_accounting_profile.approve',
  'company_accounting_profile.create',
  'company_accounting_profile.edit',
  'company_accounting_profile.review',
  'company_accounting_profile.submit',
  'counterparty.disable',
  'custody.close',
  'custody.manage',
  'document.approve',
  'document.review',
  'document.submit',
  'fiscal_year.close',
  'fiscal_year.create',
  'fiscal_year.edit',
  'monthly_close.close',
  'monthly_close.create',
  'annual_close.package.approve',
  'annual_close.package.create',
  'annual_close.package.handoff',
  'annual_close.package.review',
  'annual_close.package.snapshot.create',
  'obligation.cancel',
  'obligation.settlement.remove',
  'opening_balance.approve',
  'opening_balance.review',
  'opening_balance.submit',
  'partner.disable',
  'periodic_adjustment.approve',
  'periodic_adjustment.review',
  'tax_workpaper.adjust.create',
  'tax_workpaper.adjust.delete',
  'tax_workpaper.adjust.edit',
  'tax_workpaper.approve',
  'tax_workpaper.create',
  'tax_workpaper.edit',
  'tax_workpaper.review',
  'tax_workpaper.submit',
  'vat.close',
  'wht_review.create',
  'wht_review.edit',
  'wht_review.review',
  'wht_review.submit',
];

export const ACCOUNTANT_CAPABILITIES: readonly string[] = [
  ...VIEWER_CAPABILITIES,
  ...ACCOUNTANT_ADDITIONAL_CAPABILITIES,
];

export const FINANCE_MANAGER_CAPABILITIES: readonly string[] = [
  ...ACCOUNTANT_CAPABILITIES,
  ...FINANCE_MANAGER_ADDITIONAL_CAPABILITIES,
];

/**
 * Finance Manager grants added after migration 059 (whose matrix above stays frozen and contract-tested). Migration 097 grants these
 * to existing Finance Manager roles; company provisioning adds them to new ones. Accountant and Viewer never receive them.
 */
export const FINANCE_MANAGER_POST_059_CAPABILITIES: readonly string[] = ['opening_balance.exception.accept'];

/** What a newly provisioned Finance Manager role holds. */
export const FINANCE_MANAGER_DEFAULT_CAPABILITIES: readonly string[] = [
  ...FINANCE_MANAGER_CAPABILITIES,
  ...FINANCE_MANAGER_POST_059_CAPABILITIES,
];

/**
 * Company Manager (migration 075; owner decision 2026-10-15): manages staff, memberships, roles and capability grants of
 * its own company within the capability ceiling, and prepares operational documents. It does NOT hold manual journal
 * create/edit/post, fiscal-year or period closing/reopening, tax or VAT final approval, document or invoice approvals, or
 * access.full_access.grant. Those are granted explicitly when the company wants to. Migration 075 must stay equal to
 * this list (contract test).
 */
export const COMPANY_MANAGER_CAPABILITIES: readonly string[] = [
  ...VIEWER_CAPABILITIES,
  'access.membership.create',
  'access.membership.role.assign',
  'access.membership.status.edit',
  'access.role.capability.grant',
  'access.role.capability.revoke',
  'access.role.create',
  'access.view',
  'counterparty.create',
  'counterparty.edit',
  'document.edit',
  'document.upload',
  'invoice.create',
  'invoice.edit',
  'invoice.recurring',
  'invoice.submit',
  'invoice.view',
];

/**
 * Operations (migration 081; owner decision Phase B3): day-to-day business staff who are not accountants. Sales/purchase invoices
 * (view, create, edit, submit, approve - approval alone authorizes it, creators may approve their own), supporting documents
 * (view, upload, edit), customer/supplier records (create, edit) and read access to obligations (payment/collection status).
 * It deliberately does NOT hold manual journal create/edit/post/reverse, fiscal-year or monthly close, VAT close/reopen,
 * any access.* capability, invoice.cancel/delete/adjust/adjust_approve/recurring, or document.approve/delete.
 * Migration 081 must stay equal to this list (contract test).
 */
export const OPERATIONS_CAPABILITIES: readonly string[] = [
  'company.view',
  'counterparty.create',
  'counterparty.edit',
  'document.edit',
  'document.upload',
  'document.view',
  'invoice.approve',
  'invoice.create',
  'invoice.edit',
  'invoice.submit',
  'invoice.view',
  'obligation.view',
];

/** Registered capabilities that are deliberately NOT granted to any default role. */
export const LEGACY_UNASSIGNED_CAPABILITIES: readonly string[] = [
  'accounting.chart.manage',
  'accounting.journal.manage',
  'annual_close.package.manage',
  'asset.manage',
  'bank.account.manage',
  'company_accounting_profile.manage',
  'fiscal_year.manage',
  'obligation.manage',
  'opening_balance.manage',
  'partner.manage',
  'periodic_adjustment.manage',
  'tax_workpaper.manage',
  'obligation.settle',
];
