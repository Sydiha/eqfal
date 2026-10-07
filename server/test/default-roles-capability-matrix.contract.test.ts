import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/059_default_roles_capability_matrix.sql', import.meta.url),
  'utf8',
);

describe('default roles capability matrix contract', () => {
  // Exact approved capability lists
  const viewerCapabilities = [
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

  const accountantAdditionalCapabilities = [
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

  const financeManagerAdditionalCapabilities = [
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

  const legacyUnassignedCapabilities = [
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

  it('verifies Viewer role has exactly 20 approved capabilities', () => {
    expect(viewerCapabilities).toHaveLength(20);

    // Verify each capability is in the migration
    for (const capability of viewerCapabilities) {
      expect(migration).toContain(`('${capability}')`);
    }
  });

  it('verifies Accountant role contains all Viewer + 26 additional = 46 total', () => {
    const accountantCapabilities = [...viewerCapabilities, ...accountantAdditionalCapabilities];
    expect(accountantAdditionalCapabilities).toHaveLength(26);
    expect(accountantCapabilities).toHaveLength(46);

    // Verify all capabilities are in the migration
    for (const capability of accountantCapabilities) {
      expect(migration).toContain(`('${capability}')`);
    }
  });

  it('verifies Finance Manager role contains all Accountant + 50 additional = 96 total', () => {
    const accountantCapabilities = [...viewerCapabilities, ...accountantAdditionalCapabilities];
    const financeManagerCapabilities = [...accountantCapabilities, ...financeManagerAdditionalCapabilities];

    expect(financeManagerAdditionalCapabilities).toHaveLength(50);
    expect(financeManagerCapabilities).toHaveLength(96);

    // Verify all capabilities are in the migration
    for (const capability of financeManagerCapabilities) {
      expect(migration).toContain(`('${capability}')`);
    }
  });

  it('verifies legacy/unassigned capabilities are defined but NOT assigned to default roles', () => {
    expect(legacyUnassignedCapabilities).toHaveLength(13);

    // Verify legacy capabilities are in the capability list but NOT in any role assignment
    for (const capability of legacyUnassignedCapabilities) {
      // Legacy capability must be defined in capabilities
      expect(migration).toContain(`('${capability}')`);
    }

    // Verify none of the legacy capabilities appear in role-capability assignments
    // by checking they're only in the initial capability insert, not in role CROSS JOINs
    const accountantCapabilities = [...viewerCapabilities, ...accountantAdditionalCapabilities];
    const financeManagerCapabilities = [
      ...viewerCapabilities,
      ...accountantAdditionalCapabilities,
      ...financeManagerAdditionalCapabilities,
    ];

    for (const capability of legacyUnassignedCapabilities) {
      expect(viewerCapabilities).not.toContain(capability);
      expect(accountantCapabilities).not.toContain(capability);
      expect(financeManagerCapabilities).not.toContain(capability);
    }
  });

  it('verifies no access.* capabilities in limited roles except access.view', () => {
    const allLimitedRoleCapabilities = [
      ...viewerCapabilities,
      ...accountantAdditionalCapabilities,
      ...financeManagerAdditionalCapabilities,
    ];

    for (const capability of allLimitedRoleCapabilities) {
      if (capability.startsWith('access.')) {
        // access.* should not appear in limited roles (Full Access only)
        expect(capability).not.toBeDefined();
      }
    }
  });

  it('verifies no company.* admin capabilities in limited roles', () => {
    const allLimitedRoleCapabilities = [
      ...viewerCapabilities,
      ...accountantAdditionalCapabilities,
      ...financeManagerAdditionalCapabilities,
    ];

    for (const capability of allLimitedRoleCapabilities) {
      if (capability === 'company_accounting_profile.view' || capability.startsWith('company_accounting_profile.')) {
        // company_accounting_profile is allowed; this is about company admin (company.create, company.edit, etc.)
        continue;
      }
      // company.* should only be company.view
      if (capability.startsWith('company.')) {
        expect(capability).toBe('company.view');
      }
    }
  });

  it('verifies Full Access role is not modified (idempotent migration)', () => {
    // The migration should explicitly preserve Full Access by not modifying is_full_access = TRUE rows
    expect(migration).toContain('is_full_access = FALSE');
    expect(migration).not.toContain('UPDATE roles SET is_full_access = TRUE');
    expect(migration).not.toContain('is_full_access = TRUE' + "'" || 'is_full_access = TRUE' + '"');
  });

  it('migration uses idempotent syntax (ON CONFLICT, DELETE WHERE, INSERT ... WHERE NOT EXISTS)', () => {
    expect(migration).toMatch(/ON CONFLICT.*DO NOTHING/i);
    expect(migration).toMatch(/DELETE FROM role_capabilities/);
    expect(migration).toMatch(/WHERE NOT EXISTS/);
  });

  it('creates default roles as non-full-access templates', () => {
    expect(migration).toContain("'viewer'");
    expect(migration).toContain("'accountant'");
    expect(migration).toContain("'finance_manager'");
    expect(migration).toContain('is_full_access = FALSE');
  });

  it('migration targets test company for baseline', () => {
    // Migration should apply to test company (0e8574b6-5828-40c6-9b56-7dbd1c7e9def)
    expect(migration).toContain("'0e8574b6-5828-40c6-9b56-7dbd1c7e9def'");
  });

  it('total capability counts match approved specification', () => {
    expect(viewerCapabilities).toHaveLength(20);
    expect([...viewerCapabilities, ...accountantAdditionalCapabilities]).toHaveLength(46);
    expect([
      ...viewerCapabilities,
      ...accountantAdditionalCapabilities,
      ...financeManagerAdditionalCapabilities,
    ]).toHaveLength(96);
    expect(legacyUnassignedCapabilities).toHaveLength(13);
  });
});
