import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { SessionService } from '../src/modules/auth/session.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { AuthService } from '../src/modules/users/auth.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const pool = {} as Pool;

const user = {
  id: 'user-1',
  email: 'user@example.com',
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const memberships = [
  {
    membership_id: 'm-1',
    company_id: 'company-a',
    company_name: 'Company A',
    company_name_ar: 'الشركة أ',
    role_id: 'role-a',
  },
  {
    membership_id: 'm-2',
    company_id: 'company-b',
    company_name: 'Company B',
    company_name_ar: null,
    role_id: 'role-b',
  },
];

const activeSession = {
  id: 'session-1',
  user_id: user.id,
  user_email: user.email,
  token_hash: 'hash',
  active_company_id: 'company-a',
  expires_at: new Date(Date.now() + 60_000),
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SessionService', () => {
  it('does not create a session when credentials are invalid', async () => {
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(null);
    const create = vi.spyOn(SessionRepository.prototype, 'create');

    const result = await new SessionService(pool).login('bad@example.com', 'wrong');

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a server-side session and selects the first active membership deterministically', async () => {
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(user);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['report.view']);
    const create = vi.spyOn(SessionRepository.prototype, 'create').mockResolvedValue(activeSession);

    const result = await new SessionService(pool).login(user.email, 'secret');

    expect(result?.activeCompanyId).toBe('company-a');
    expect(result?.allowedCompanies.map((c) => c.id)).toEqual(['company-a', 'company-b']);
    expect(result?.capabilities).toEqual(['report.view']);
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id,
      activeCompanyId: 'company-a',
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('returns centrally resolved Full Access capabilities at login', async () => {
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(user);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(SessionRepository.prototype, 'create').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities')
      .mockResolvedValue(['report.view', 'future.capability']);

    const result = await new SessionService(pool).login(user.email, 'secret');

    expect(result?.capabilities).toEqual(['report.view', 'future.capability']);
  });

  it('allows identity login with no active company membership', async () => {
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(user);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([]);
    const caps = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities');
    vi.spyOn(SessionRepository.prototype, 'create').mockResolvedValue({ ...activeSession, active_company_id: null });

    const result = await new SessionService(pool).login(user.email, 'secret');

    expect(result?.activeCompanyId).toBeNull();
    expect(result?.allowedCompanies).toEqual([]);
    expect(result?.capabilities).toEqual([]);
    expect(caps).not.toHaveBeenCalled();
  });

  it('returns null for an invalid or expired session token', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);

    expect(await new SessionService(pool).getContext('invalid')).toBeNull();
  });

  it('preserves the current company when its membership is still active', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['report.view']);
    const update = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany');

    const result = await new SessionService(pool).getContext('token');

    expect(result?.activeCompanyId).toBe('company-a');
    expect(update).not.toHaveBeenCalled();
  });

  it('getContext reloads updated effective capabilities from the database', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    const capabilities = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities')
      .mockResolvedValue(['newly.inserted.capability']);

    const result = await new SessionService(pool).getContext('token');

    expect(result?.capabilities).toEqual(['newly.inserted.capability']);
    expect(capabilities).toHaveBeenCalledWith(user.id, 'company-a');
  });

  it('reconciles a removed/disabled active membership to another allowed company', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue({
      ...activeSession,
      active_company_id: 'removed-company',
    });
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['report.view']);
    const update = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();

    const result = await new SessionService(pool).getContext('token');

    expect(result?.activeCompanyId).toBe('company-a');
    expect(update).toHaveBeenCalledWith('session-1', 'company-a');
  });

  it('reconciles to no active company when all memberships are removed/disabled', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([]);
    const update = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();

    const result = await new SessionService(pool).getContext('token');

    expect(result?.activeCompanyId).toBeNull();
    expect(result?.capabilities).toEqual([]);
    expect(update).toHaveBeenCalledWith('session-1', null);
  });

  it('rejects switching to a company outside active memberships without changing the session', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    const update = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany');

    const result = await new SessionService(pool).switchCompany('token', 'company-x');

    expect(result).toBe('forbidden');
    expect(update).not.toHaveBeenCalled();
  });

  it('validates a company switch server-side and reloads capabilities for the target company', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();
    const caps = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['invoice.create']);

    const result = await new SessionService(pool).switchCompany('token', 'company-b');

    expect(result).not.toBeNull();
    expect(result).not.toBe('forbidden');
    if (result && result !== 'forbidden') {
      expect(result.activeCompanyId).toBe('company-b');
      expect(result.capabilities).toEqual(['invoice.create']);
    }
    expect(caps).toHaveBeenCalledWith(user.id, 'company-b');
  });

  it('company switch uses only the target company effective capabilities', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();
    const capabilities = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities')
      .mockImplementation(async (_userId, companyId) => (
        companyId === 'company-b' ? ['company-b.explicit'] : ['company-a.full-access']
      ));

    const result = await new SessionService(pool).switchCompany('token', 'company-b');

    expect(result && result !== 'forbidden' ? result.capabilities : null)
      .toEqual(['company-b.explicit']);
    expect(capabilities).toHaveBeenCalledWith(user.id, 'company-b');
  });

  it('returns unauthenticated when switching with an invalid session', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);

    expect(await new SessionService(pool).switchCompany('invalid', 'company-a')).toBeNull();
  });

  it('invalidates the exact server-side session on logout', async () => {
    const remove = vi.spyOn(SessionRepository.prototype, 'deleteByTokenHash').mockResolvedValue();
    const token = 'opaque-token';

    await new SessionService(pool).logout(token);

    expect(remove).toHaveBeenCalledWith(
      crypto.createHash('sha256').update(token).digest('hex'),
    );
  });
});
