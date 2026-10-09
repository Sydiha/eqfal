import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import { MembershipService } from '../src/modules/memberships/membership.service';
import {
  ACCOUNTANT_CAPABILITIES,
  FINANCE_MANAGER_CAPABILITIES,
  LEGACY_UNASSIGNED_CAPABILITIES,
  VIEWER_CAPABILITIES,
} from '../src/modules/memberships/default-role-capabilities';

vi.mock('../src/shared/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Regression tests for default role authorization matrix.
 * These tests verify that the approved role capabilities translate to correct
 * authorization behavior across the application domains.
 *
 * The role-shape suites check the canonical definition; the 'Real repository authorization'
 * suite drives the real MembershipRepository/MembershipService through an in-memory pg Pool.
 */

describe('default roles authorization contract', () => {
  describe('Viewer role (read-only)', () => {

    it('can view all domains', () => {
      expect(VIEWER_CAPABILITIES.filter((c) => c.includes('.view'))).toHaveLength(20);
    });

    it('cannot mutate any domain (no .create, .edit, .post, .approve, .review, .submit, .manage)', () => {
      const mutationKeywords = ['create', 'edit', 'post', 'approve', 'review', 'submit', 'manage', 'confirm', 'settle', 'upload'];
      for (const capability of VIEWER_CAPABILITIES) {
        for (const keyword of mutationKeywords) {
          expect(capability).not.toContain(`.${keyword}`);
        }
      }
    });

    it('has no access administration capabilities', () => {
      expect(VIEWER_CAPABILITIES.filter((c) => c.startsWith('access.'))).toHaveLength(0);
    });

    it('has company.view only (no company.create/edit/manage)', () => {
      const companyCapabilities = VIEWER_CAPABILITIES.filter((c) => c.startsWith('company.') && !c.includes('company_accounting_profile'));
      expect(companyCapabilities).toEqual(['company.view']);
    });
  });

  describe('Accountant role (operational write access)', () => {


    const accountantCapabilities = ACCOUNTANT_CAPABILITIES;

    it('contains all Viewer capabilities', () => {
      for (const cap of VIEWER_CAPABILITIES) {
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



    const fmCapabilities = FINANCE_MANAGER_CAPABILITIES;

    it('contains all Accountant capabilities', () => {
      const accountantCapabilities = ACCOUNTANT_CAPABILITIES;
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

  // Real multi-company isolation and Full Access dynamic behavior: see 'Real repository authorization' below.

  describe('Legacy capabilities are unassigned', () => {




    it('are defined in the database but not assigned to any default role', () => {
      const defaultRoleCapabilities = FINANCE_MANAGER_CAPABILITIES;

      for (const legacyCapability of LEGACY_UNASSIGNED_CAPABILITIES) {
        expect(defaultRoleCapabilities).not.toContain(legacyCapability);
      }

      // Legacy capabilities should be defined (so they can be migrated to if needed for backward compat)
      expect(LEGACY_UNASSIGNED_CAPABILITIES).toHaveLength(13);
    });
  });
});

// ─── Real repository / service authorization ─────────────────────────────────

interface FakeDb {
  companies: Array<{ id: string; is_active: boolean }>;
  capabilities: string[];
  roles: Array<{ id: string; company_id: string; name: string; is_full_access: boolean }>;
  role_capabilities: Array<{ role_id: string; capability_id: string }>;
  memberships: Array<{ user_id: string; company_id: string; role_id: string; is_active: boolean }>;
}

/**
 * In-memory pg Pool. For the real getActiveCapabilities() SQL it evaluates the same semantics
 * the SQL expresses: membership(user, company, active) JOIN active company JOIN role with
 * r.company_id = m.company_id, then every capability row when r.is_full_access, otherwise only
 * explicit role_capabilities rows. The SQL text itself is asserted by the guard test below.
 */
function makeFakePool(db: FakeDb): Pool {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (!/JOIN capabilities cap ON \(r\.is_full_access = TRUE AND cap\.implicit_full_access = TRUE\)/.test(sql)) {
      throw new Error(`Unexpected SQL in fake pool: ${sql.slice(0, 80)}`);
    }
    const [userId, companyId] = params as [string, string];
    const rows: Array<{ capability_id: string }> = [];
    for (const m of db.memberships) {
      if (m.user_id !== userId || m.company_id !== companyId || !m.is_active) continue;
      if (!db.companies.some((c) => c.id === m.company_id && c.is_active)) continue;
      const r = db.roles.find((x) => x.id === m.role_id && x.company_id === m.company_id);
      if (!r) continue;
      for (const cap of db.capabilities) {
        if (r.is_full_access || db.role_capabilities.some((rc) => rc.role_id === r.id && rc.capability_id === cap)) {
          rows.push({ capability_id: cap });
        }
      }
    }
    return { rows, rowCount: rows.length };
  });
  return { query, connect: vi.fn() } as unknown as Pool;
}

const CO_A = 'company-a';
const CO_B = 'company-b';
const USER = 'user-1';

/** Both companies provisioned like company.service.ts does: 3 explicit-matrix roles + Full Access (no rows). */
function buildDb(): FakeDb {
  const db: FakeDb = {
    companies: [{ id: CO_A, is_active: true }, { id: CO_B, is_active: true }],
    capabilities: [...new Set([...FINANCE_MANAGER_CAPABILITIES, ...LEGACY_UNASSIGNED_CAPABILITIES, 'access.view', 'access.role.edit'])],
    roles: [],
    role_capabilities: [],
    memberships: [],
  };
  const matrix: Record<string, readonly string[]> = {
    Viewer: VIEWER_CAPABILITIES,
    Accountant: ACCOUNTANT_CAPABILITIES,
    'Finance Manager': FINANCE_MANAGER_CAPABILITIES,
  };
  for (const company of [CO_A, CO_B]) {
    for (const [name, caps] of Object.entries(matrix)) {
      const id = `${company}:${name}`;
      db.roles.push({ id, company_id: company, name, is_full_access: false });
      for (const c of caps) db.role_capabilities.push({ role_id: id, capability_id: c });
    }
    db.roles.push({ id: `${company}:Full Access`, company_id: company, name: 'Full Access', is_full_access: true });
  }
  return db;
}

describe('Real repository authorization', () => {
  it('guards the fake: the real repository SQL still has the joins the fake models', async () => {
    const pool = makeFakePool(buildDb());
    const spy = pool.query as ReturnType<typeof vi.fn>;
    await new MembershipRepository(pool).getActiveCapabilities(USER, CO_A);
    const sql = String(spy.mock.calls[0]?.[0]);
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('c.is_active = TRUE');
    expect(sql).toContain('m.is_active  = TRUE');
    expect(sql).toMatch(/JOIN capabilities cap ON \(r\.is_full_access = TRUE AND cap\.implicit_full_access = TRUE\)\s+OR EXISTS/);
  });

  describe('Multi-company isolation', () => {
    it('same user is Viewer in Company A and Finance Manager in Company B and gets only the active company capabilities', async () => {
      const db = buildDb();
      db.memberships.push(
        { user_id: USER, company_id: CO_A, role_id: `${CO_A}:Viewer`, is_active: true },
        { user_id: USER, company_id: CO_B, role_id: `${CO_B}:Finance Manager`, is_active: true },
      );
      const service = new MembershipService(makeFakePool(db));

      const inA = await service.getCapabilities(USER, CO_A);
      const inB = await service.getCapabilities(USER, CO_B);

      expect(new Set(inA)).toEqual(new Set(VIEWER_CAPABILITIES));
      expect(inA).toHaveLength(20);
      expect(new Set(inB)).toEqual(new Set(FINANCE_MANAGER_CAPABILITIES));
      expect(inB).toHaveLength(96);
      expect(await service.isAuthorized(USER, CO_A, 'accounting.journal.post')).toBe(false);
      expect(await service.isAuthorized(USER, CO_B, 'accounting.journal.post')).toBe(true);
    });

    it('a Company A role cannot authorize Company B (no membership in B, and cross-company role_id fails closed)', async () => {
      const db = buildDb();
      // Finance Manager in A only; no membership in B at all
      db.memberships.push({ user_id: USER, company_id: CO_A, role_id: `${CO_A}:Finance Manager`, is_active: true });
      const service = new MembershipService(makeFakePool(db));
      expect(await service.getCapabilities(USER, CO_B)).toEqual([]);
      expect(await service.isAuthorized(USER, CO_B, 'report.view')).toBe(false);
      expect(await service.isAuthorized(USER, CO_A, 'asset.approve')).toBe(true);

      // Corrupted membership in B pointing at Company A's Full Access role must still grant nothing
      db.memberships.push({ user_id: USER, company_id: CO_B, role_id: `${CO_A}:Full Access`, is_active: true });
      expect(await service.getCapabilities(USER, CO_B)).toEqual([]);
      expect(await service.isAuthorized(USER, CO_B, 'access.view')).toBe(false);
    });

    it('Full Access in Company A does not leak into Company B where the user is Viewer', async () => {
      const db = buildDb();
      db.memberships.push(
        { user_id: USER, company_id: CO_A, role_id: `${CO_A}:Full Access`, is_active: true },
        { user_id: USER, company_id: CO_B, role_id: `${CO_B}:Viewer`, is_active: true },
      );
      const service = new MembershipService(makeFakePool(db));
      expect(await service.isAuthorized(USER, CO_A, 'access.view')).toBe(true);
      expect(await service.isAuthorized(USER, CO_B, 'access.view')).toBe(false);
      expect(await service.getCapabilities(USER, CO_B)).toHaveLength(20);
    });
  });

  describe('Full Access role (dynamic)', () => {
    it('resolves ALL registered capabilities with no explicit role_capabilities rows', async () => {
      const db = buildDb();
      db.memberships.push({ user_id: USER, company_id: CO_A, role_id: `${CO_A}:Full Access`, is_active: true });
      expect(db.role_capabilities.filter((rc) => rc.role_id === `${CO_A}:Full Access`)).toEqual([]);

      const caps = await new MembershipService(makeFakePool(db)).getCapabilities(USER, CO_A);

      expect(caps).toHaveLength(db.capabilities.length);
      expect(new Set(caps)).toEqual(new Set(db.capabilities));
      for (const c of [...FINANCE_MANAGER_CAPABILITIES, ...LEGACY_UNASSIGNED_CAPABILITIES, 'access.view', 'access.role.edit']) {
        expect(caps).toContain(c);
      }
    });

    it('a newly registered capability reaches Full Access without role_capabilities but NOT Viewer, Accountant or Finance Manager', async () => {
      const db = buildDb();
      const NEW_CAP = 'new_feature.create';
      db.capabilities.push(NEW_CAP); // registered only in `capabilities`; no role_capabilities row anywhere
      db.memberships.push(
        { user_id: 'u-full', company_id: CO_A, role_id: `${CO_A}:Full Access`, is_active: true },
        { user_id: 'u-viewer', company_id: CO_A, role_id: `${CO_A}:Viewer`, is_active: true },
        { user_id: 'u-acct', company_id: CO_A, role_id: `${CO_A}:Accountant`, is_active: true },
        { user_id: 'u-fm', company_id: CO_A, role_id: `${CO_A}:Finance Manager`, is_active: true },
      );
      expect(db.role_capabilities.some((rc) => rc.capability_id === NEW_CAP)).toBe(false);
      const service = new MembershipService(makeFakePool(db));

      expect(await service.isAuthorized('u-full', CO_A, NEW_CAP)).toBe(true);
      expect(await service.isAuthorized('u-viewer', CO_A, NEW_CAP)).toBe(false);
      expect(await service.isAuthorized('u-acct', CO_A, NEW_CAP)).toBe(false);
      expect(await service.isAuthorized('u-fm', CO_A, NEW_CAP)).toBe(false);
      // and the limited roles are otherwise unchanged
      expect(await service.getCapabilities('u-viewer', CO_A)).toHaveLength(VIEWER_CAPABILITIES.length);
      expect(await service.getCapabilities('u-acct', CO_A)).toHaveLength(ACCOUNTANT_CAPABILITIES.length);
      expect(await service.getCapabilities('u-fm', CO_A)).toHaveLength(FINANCE_MANAGER_CAPABILITIES.length);
    });

    it('access.* capabilities (including access.view) reach only Full Access', async () => {
      const db = buildDb();
      db.memberships.push(
        { user_id: 'u-full', company_id: CO_A, role_id: `${CO_A}:Full Access`, is_active: true },
        { user_id: 'u-viewer', company_id: CO_A, role_id: `${CO_A}:Viewer`, is_active: true },
        { user_id: 'u-acct', company_id: CO_A, role_id: `${CO_A}:Accountant`, is_active: true },
        { user_id: 'u-fm', company_id: CO_A, role_id: `${CO_A}:Finance Manager`, is_active: true },
      );
      const service = new MembershipService(makeFakePool(db));
      expect(await service.isAuthorized('u-full', CO_A, 'access.view')).toBe(true);
      for (const u of ['u-viewer', 'u-acct', 'u-fm']) {
        expect((await service.getCapabilities(u, CO_A)).filter((c) => c.startsWith('access.'))).toEqual([]);
        expect(await service.isAuthorized(u, CO_A, 'access.view')).toBe(false);
      }
    });
  });
});
