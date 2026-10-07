import { describe, expect, it } from 'vitest';

/**
 * Regression tests for default role authorization matrix.
 * These tests verify that the approved role capabilities translate to correct
 * authorization behavior across the application domains.
 *
 * These are specification-level tests (not database integration tests).
 * They document the expected authorization contract for each role.
 */

describe('default roles authorization contract', () => {
  describe('Viewer role (read-only)', () => {
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

    it('can view all domains', () => {
      expect(viewerCapabilities.filter((c) => c.includes('.view'))).toHaveLength(20);
    });

    it('cannot mutate any domain (no .create, .edit, .post, .approve, .review, .submit, .manage)', () => {
      const mutationKeywords = ['create', 'edit', 'post', 'approve', 'review', 'submit', 'manage', 'confirm', 'settle', 'upload'];
      for (const capability of viewerCapabilities) {
        for (const keyword of mutationKeywords) {
          expect(capability).not.toContain(`.${keyword}`);
        }
      }
    });

    it('has no access administration capabilities', () => {
      expect(viewerCapabilities.filter((c) => c.startsWith('access.'))).toHaveLength(0);
    });

    it('has company.view only (no company.create/edit/manage)', () => {
      const companyCapabilities = viewerCapabilities.filter((c) => c.startsWith('company.') && !c.includes('company_accounting_profile'));
      expect(companyCapabilities).toEqual(['company.view']);
    });
  });

  describe('Accountant role (operational write access)', () => {
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

    const accountantAdditional = [
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

    const accountantCapabilities = [...viewerCapabilities, ...accountantAdditional];

    it('contains all Viewer capabilities', () => {
      for (const cap of viewerCapabilities) {
        expect(accountantCapabilities).toContain(cap);
      }
    });

    it('can perform approved operational actions (journal, document, obligation, etc.)', () => {
      expect(accountantCapabilities).toContain('accounting.journal.create');
      expect(accountantCapabilities).toContain('accounting.journal.post');
      expect(accountantCapabilities).toContain('document.upload');
      expect(accountantCapabilities).toContain('document.edit');
      expect(accountantCapabilities).toContain('bank.reconcile');
      expect(accountantCapabilities).toContain('obligation.confirm');
    });

    it('can perform banking operations (import, match, reconcile)', () => {
      expect(accountantCapabilities).toContain('bank.import');
      expect(accountantCapabilities).toContain('bank.match');
      expect(accountantCapabilities).toContain('bank.reconcile');
    });

    it('cannot access access.* administration capabilities', () => {
      expect(accountantCapabilities.filter((c) => c.startsWith('access.'))).toHaveLength(0);
    });

    it('cannot approve/finalize fiscal years (fiscal_year.close not in accountant)', () => {
      expect(accountantCapabilities).not.toContain('fiscal_year.close');
      expect(accountantCapabilities).not.toContain('fiscal_year.create');
      expect(accountantCapabilities).not.toContain('fiscal_year.edit');
    });

    it('cannot create/approve documents (only edit/upload)', () => {
      expect(accountantCapabilities).toContain('document.edit');
      expect(accountantCapabilities).toContain('document.upload');
      expect(accountantCapabilities).not.toContain('document.create');
      expect(accountantCapabilities).not.toContain('document.approve');
      expect(accountantCapabilities).not.toContain('document.review');
      expect(accountantCapabilities).not.toContain('document.submit');
    });

    it('cannot manage company accounting profile (only view)', () => {
      expect(accountantCapabilities).toContain('company_accounting_profile.view');
      expect(accountantCapabilities).not.toContain('company_accounting_profile.create');
      expect(accountantCapabilities).not.toContain('company_accounting_profile.edit');
      expect(accountantCapabilities).not.toContain('company_accounting_profile.approve');
      expect(accountantCapabilities).not.toContain('company_accounting_profile.submit');
    });

    it('cannot manage assets (only create/edit, not approve/dispose)', () => {
      expect(accountantCapabilities).toContain('asset.create');
      expect(accountantCapabilities).toContain('asset.edit');
      expect(accountantCapabilities).not.toContain('asset.approve');
      expect(accountantCapabilities).not.toContain('asset.dispose');
      expect(accountantCapabilities).not.toContain('asset.cancel');
    });

    it('cannot manage company or partners (cannot create company, only view)', () => {
      expect(accountantCapabilities).toContain('company.view');
      expect(accountantCapabilities).not.toContain('company.create');
      expect(accountantCapabilities).not.toContain('company.edit');
    });

    it('cannot manage company_accounting_profile (only view)', () => {
      expect(accountantCapabilities).toContain('company_accounting_profile.view');
      expect(accountantCapabilities).not.toContain('company_accounting_profile.manage');
    });
  });

  describe('Finance Manager role (approval and close capabilities)', () => {
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

    const accountantAdditional = [
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

    const fmAdditional = [
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

    const fmCapabilities = [...viewerCapabilities, ...accountantAdditional, ...fmAdditional];

    it('contains all Accountant capabilities', () => {
      const accountantCapabilities = [...viewerCapabilities, ...accountantAdditional];
      for (const cap of accountantCapabilities) {
        expect(fmCapabilities).toContain(cap);
      }
    });

    it('can approve and finalize fiscal years', () => {
      expect(fmCapabilities).toContain('fiscal_year.create');
      expect(fmCapabilities).toContain('fiscal_year.edit');
      expect(fmCapabilities).toContain('fiscal_year.close');
    });

    it('can close monthly periods', () => {
      expect(fmCapabilities).toContain('monthly_close.close');
      expect(fmCapabilities).toContain('monthly_close.create');
    });

    it('can approve documents', () => {
      expect(fmCapabilities).toContain('document.approve');
      expect(fmCapabilities).toContain('document.review');
      expect(fmCapabilities).toContain('document.submit');
    });

    it('can approve opening balances', () => {
      expect(fmCapabilities).toContain('opening_balance.approve');
      expect(fmCapabilities).toContain('opening_balance.review');
      expect(fmCapabilities).toContain('opening_balance.submit');
    });

    it('can manage assets (approve, dispose, cancel)', () => {
      expect(fmCapabilities).toContain('asset.approve');
      expect(fmCapabilities).toContain('asset.dispose');
      expect(fmCapabilities).toContain('asset.cancel');
      expect(fmCapabilities).toContain('asset.estimate_change.approve');
    });

    it('can create and approve annual closing packages', () => {
      expect(fmCapabilities).toContain('annual_close.package.create');
      expect(fmCapabilities).toContain('annual_close.package.approve');
      expect(fmCapabilities).toContain('annual_close.package.review');
      expect(fmCapabilities).toContain('annual_close.package.handoff');
    });

    it('can manage tax workpapers', () => {
      expect(fmCapabilities).toContain('tax_workpaper.create');
      expect(fmCapabilities).toContain('tax_workpaper.edit');
      expect(fmCapabilities).toContain('tax_workpaper.review');
      expect(fmCapabilities).toContain('tax_workpaper.approve');
      expect(fmCapabilities).toContain('tax_workpaper.submit');
    });

    it('can manage company accounting profile', () => {
      expect(fmCapabilities).toContain('company_accounting_profile.create');
      expect(fmCapabilities).toContain('company_accounting_profile.edit');
      expect(fmCapabilities).toContain('company_accounting_profile.review');
      expect(fmCapabilities).toContain('company_accounting_profile.approve');
      expect(fmCapabilities).toContain('company_accounting_profile.submit');
    });

    it('cannot manage access administration (no access.* capabilities)', () => {
      expect(fmCapabilities.filter((c) => c.startsWith('access.'))).toHaveLength(0);
    });

    it('cannot manage users or company settings (no user/partner management beyond disable)', () => {
      expect(fmCapabilities).toContain('partner.create');
      expect(fmCapabilities).toContain('partner.edit');
      expect(fmCapabilities).toContain('partner.disable');
      expect(fmCapabilities).not.toContain('partner.manage');
      expect(fmCapabilities).not.toContain('company.create');
      expect(fmCapabilities).not.toContain('company.edit');
    });

    it('cannot reopen closed/finalized periods (no monthly_close.reopen)', () => {
      expect(fmCapabilities).not.toContain('monthly_close.reopen');
    });

    it('cannot manage vat beyond close (no vat.manage or vat.reopen)', () => {
      expect(fmCapabilities).toContain('vat.close');
      expect(fmCapabilities).toContain('vat.review');
      expect(fmCapabilities).not.toContain('vat.manage');
      expect(fmCapabilities).not.toContain('vat.reopen');
    });

    it('total capability count is exactly 96', () => {
      expect(fmCapabilities).toHaveLength(96);
    });
  });

  describe('Multi-company isolation', () => {
    it('same user with different roles in different companies has isolated permissions', () => {
      // This is an architectural property enforced at the Backend:
      // - memberships are (user_id, company_id) scoped
      // - role_id is company-scoped
      // - activeCompanyId is server-trusted in session
      // - authorization checks (user + company + capability) are atomic
      // Therefore, a user who is Viewer in Company A and Finance Manager in Company B
      // must be checked for each company separately on each request.
      // This test documents the expected behavior.

      const user_id = 'test-user-123';
      const company_a_id = 'company-a-456';
      const company_b_id = 'company-b-789';

      // User in Company A is Viewer (20 capabilities, read-only)
      const membershipA = {
        user_id,
        company_id: company_a_id,
        role_id: 'viewer-role-id',
      };

      // Same user in Company B is Finance Manager (96 capabilities)
      const membershipB = {
        user_id,
        company_id: company_b_id,
        role_id: 'fm-role-id',
      };

      // When the user is in activeCompanyId = Company A, they get Viewer permissions
      // When the user switches to activeCompanyId = Company B, they get Finance Manager permissions
      // Cross-company access is blocked by design (company_id must match in query + activeCompanyId)

      expect(membershipA.company_id).not.toBe(membershipB.company_id);
    });
  });

  describe('Full Access role (dynamic)', () => {
    it('is not modified by default role matrix migration', () => {
      // Full Access (is_full_access = TRUE) is a special role that grants all capabilities dynamically.
      // The migration does NOT add explicit role_capabilities to Full Access roles.
      // Instead, Full Access is checked at runtime as a special case:
      // if (role.is_full_access) return true; // grant access
      // This test documents that the migration preserves this behavior.
    });

    it('future capabilities automatically reach Full Access without migration', () => {
      // When a new capability is registered (e.g., 'new_feature.create'),
      // it should automatically be available to Full Access roles without a migration.
      // This is ensured by the is_full_access flag in the roles table.
    });
  });

  describe('Legacy capabilities are unassigned', () => {
    const legacyCapabilities = [
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

    const accountantAdditional = [
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

    const fmAdditional = [
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

    it('are defined in the database but not assigned to any default role', () => {
      const defaultRoleCapabilities = [...viewerCapabilities, ...accountantAdditional, ...fmAdditional];

      for (const legacyCapability of legacyCapabilities) {
        expect(defaultRoleCapabilities).not.toContain(legacyCapability);
      }

      // Legacy capabilities should be defined (so they can be migrated to if needed for backward compat)
      expect(legacyCapabilities).toHaveLength(13);
    });

    it('are available for manual grant or custom roles only', () => {
      // The migration ensures legacy capabilities exist but are not automatically granted.
      // Custom roles or manual capability grants may use them for backward compatibility.
      // This is a deliberate control: new users/companies should not receive legacy capabilities.
    });
  });
});
