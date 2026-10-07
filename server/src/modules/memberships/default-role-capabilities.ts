/**
 * Canonical default role capability matrix (Viewer, Accountant, Finance Manager).
 *
 * Single TypeScript source of truth used by company provisioning and by tests.
 * Migration 059 is self-contained SQL and intentionally does NOT import this
 * module; a contract test parses the SQL and asserts exact set equality.
 *
 * Hierarchy: Viewer is a subset of Accountant, which is a subset of Finance Manager.
 * Full Access is not listed here: it resolves every registered capability dynamically
 * (roles.is_full_access) and has no explicit role_capabilities rows.
 * ALL access.* capabilities (including access.view) are Full Access only.
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
